const BrokerPool = require('./brokerPool')
const createRetry = require('../retry')
const connectionBuilder = require('./connectionBuilder')
const flatten = require('../utils/flatten')
const { EARLIEST_OFFSET, LATEST_OFFSET } = require('../constants')
const {
  KafkaJSError,
  KafkaJSBrokerNotFound,
  KafkaJSMetadataNotLoaded,
  KafkaJSTopicMetadataNotLoaded,
  KafkaJSGroupCoordinatorNotFound,
} = require('../errors')
const COORDINATOR_TYPES = require('../protocol/coordinatorTypes')

const { keys } = Object

const mergeTopics = (obj, { topic, partitions }) => ({
  ...obj,
  [topic]: [...(obj[topic] || []), ...partitions],
})

/**
 * @param {Array<string>} brokers example: ['127.0.0.1:9092', '127.0.0.1:9094']
 * @param {Object} ssl
 * @param {Object} sasl
 * @param {string} clientId
 * @param {number} connectionTimeout - in milliseconds
 * @param {number} authenticationTimeout - in milliseconds
 * @param {number} requestTimeout - in milliseconds
 * @param {number} metadataMaxAge - in milliseconds
 * @param {boolean} allowAutoTopicCreation
 * @param {number} maxInFlightRequests
 * @param {IsolationLevel} isolationLevel
 * @param {Object} retry
 * @param {Logger} logger
 * @param {Map} offsets
 * @param {InstrumentationEventEmitter} [instrumentationEmitter=null]
 */
module.exports = class Cluster {
  constructor({
    logger: rootLogger,
    socketFactory,
    brokers,
    ssl,
    sasl,
    clientId,
    connectionTimeout,
    authenticationTimeout,
    requestTimeout,
    enforceRequestTimeout,
    metadataMaxAge,
    retry,
    allowExperimentalV011,
    allowAutoTopicCreation,
    maxInFlightRequests,
    isolationLevel,
    instrumentationEmitter = null,
    offsets = new Map(),
  }) {
    this.rootLogger = rootLogger
    this.logger = rootLogger.namespace('Cluster')
    this.retrier = createRetry({ ...retry })
    this.connectionBuilder = connectionBuilder({
      logger: rootLogger,
      instrumentationEmitter,
      socketFactory,
      brokers,
      ssl,
      sasl,
      clientId,
      connectionTimeout,
      requestTimeout,
      enforceRequestTimeout,
      maxInFlightRequests,
      retry,
    })

    this.targetTopics = new Set()
    this.isolationLevel = isolationLevel
    this.brokerPool = new BrokerPool({
      connectionBuilder: this.connectionBuilder,
      logger: this.rootLogger,
      retry,
      allowExperimentalV011,
      allowAutoTopicCreation,
      authenticationTimeout,
      metadataMaxAge,
    })
    this.committedOffsetsByGroup = offsets
  }

  isConnected() {
    return this.brokerPool.hasConnectedBrokers()
  }

  /**
   * @public
   * @returns {Promise<null>}
   */
  async connect() {
    await this.brokerPool.connect()
  }

  /**
   * @public
   * @returns {Promise<null>}
   */
  async disconnect() {
    await this.brokerPool.disconnect()
  }

  /**
   * @public
   * @returns {Promise<null>}
   */
  async refreshMetadata() {
    await this.brokerPool.refreshMetadata(Array.from(this.targetTopics))
  }

  /**
   * @public
   * @returns {Promise<null>}
   */
  async refreshMetadataIfNecessary() {
    await this.brokerPool.refreshMetadataIfNecessary(Array.from(this.targetTopics))
  }

  /**
   * @public
   * @returns {Promise<Metadata>}
   */
  async metadata({ topics = [] } = {}) {
    return this.retrier(async (bail, retryCount, retryTime) => {
      try {
        await this.brokerPool.refreshMetadataIfNecessary(topics)
        return this.brokerPool.withBroker(async ({ broker }) => broker.metadata(topics))
      } catch (e) {
        if (e.type === 'LEADER_NOT_AVAILABLE') {
          throw e
        }

        bail(e)
      }
    })
  }

  /**
   * @public
   * @param {string} topic
   * @return {Promise}
   */
  async addTargetTopic(topic) {
    return this.addMultipleTargetTopics([topic])
  }

  /**
   * @public
   * @param {string[]} topics
   * @return {Promise}
   */
  async addMultipleTargetTopics(topics) {
    const previousSize = this.targetTopics.size
    for (let topic of topics) {
      this.targetTopics.add(topic)
    }

    const hasChanged = previousSize !== this.targetTopics.size || !this.brokerPool.metadata

    if (hasChanged) {
      await this.refreshMetadata()
    }
  }

  /**
   * @public
   * @param {string} nodeId
   * @returns {Promise<Broker>}
   */
  async findBroker({ nodeId }) {
    try {
      return await this.brokerPool.findBroker({ nodeId })
    } catch (e) {
      // The client probably has stale metadata
      if (
        e.name === 'KafkaJSBrokerNotFound' ||
        e.name === 'KafkaJSLockTimeout' ||
        e.code === 'ECONNREFUSED'
      ) {
        await this.refreshMetadata()
      }

      throw e
    }
  }

  /**
   * @public
   * @returns {Promise<Broker>}
   */
  async findControllerBroker() {
    const { metadata } = this.brokerPool

    if (!metadata || metadata.controllerId == null) {
      throw new KafkaJSMetadataNotLoaded('Topic metadata not loaded')
    }

    const broker = await this.findBroker({ nodeId: metadata.controllerId })

    if (!broker) {
      throw new KafkaJSBrokerNotFound(
        `Controller broker with id ${metadata.controllerId} not found in the cached metadata`
      )
    }

    return broker
  }

  /**
   * @public
   * @param {string} topic
   * @returns {Object} Example:
   *                   [{
   *                     isr: [2],
   *                     leader: 2,
   *                     partitionErrorCode: 0,
   *                     partitionId: 0,
   *                     replicas: [2],
   *                   }]
   */
  findTopicPartitionMetadata(topic) {
    const { metadata } = this.brokerPool
    if (!metadata || !metadata.topicMetadata) {
      throw new KafkaJSTopicMetadataNotLoaded('Topic metadata not loaded', { topic })
    }

    const topicMetadata = metadata.topicMetadata.find(t => t.topic === topic)
    return topicMetadata ? topicMetadata.partitionMetadata : []
  }

  /**
   * @public
   * @param {string} topic
   * @param {Array<number>} partitions
   * @returns {Object} Object with leader and partitions. For partitions 0 and 5
   *                   the result could be:
   *                     { '0': [0], '2': [5] }
   *
   *                   where the key is the nodeId.
   */
  findLeaderForPartitions(topic, partitions) {
    const partitionMetadata = this.findTopicPartitionMetadata(topic)
    return partitions.reduce((result, id) => {
      const partitionId = parseInt(id, 10)
      const metadata = partitionMetadata.find(p => p.partitionId === partitionId)

      if (!metadata) {
        return result
      }

      if (metadata.leader === null || metadata.leader === undefined) {
        throw new KafkaJSError('Invalid partition metadata', { topic, partitionId, metadata })
      }

      const { leader } = metadata
      const current = result[leader] || []
      return { ...result, [leader]: [...current, partitionId] }
    }, {})
  }

  /**
   * @public
   * @param {string} groupId
   * @param {number} [coordinatorType=0]
   * @returns {Promise<Broker>}
   */
  async findGroupCoordinator({ groupId, coordinatorType = COORDINATOR_TYPES.GROUP }) {
    return this.retrier(async (bail, retryCount, retryTime) => {
      try {
        const { coordinator } = await this.findGroupCoordinatorMetadata({
          groupId,
          coordinatorType,
        })
        return await this.findBroker({ nodeId: coordinator.nodeId })
      } catch (e) {
        // A new broker can join the cluster before we have the chance
        // to refresh metadata
        if (e.name === 'KafkaJSBrokerNotFound' || e.type === 'GROUP_COORDINATOR_NOT_AVAILABLE') {
          this.logger.debug(`${e.message}, refreshing metadata and trying again...`, {
            groupId,
            retryCount,
            retryTime,
          })

          await this.refreshMetadata()
          throw e
        }

        if (e.code === 'ECONNREFUSED') {
          // During maintenance the current coordinator can go down; findBroker will
          // refresh metadata and re-throw the error. findGroupCoordinator has to re-throw
          // the error to go through the retry cycle.
          throw e
        }

        bail(e)
      }
    })
  }

  /**
   * @public
   * @param {string} groupId
   * @param {number} [coordinatorType=0]
   * @returns {Promise<Object>}
   */
  async findGroupCoordinatorMetadata({ groupId, coordinatorType }) {
    const brokerMetadata = await this.brokerPool.withBroker(async ({ nodeId, broker }) => {
      return await this.retrier(async (bail, retryCount, retryTime) => {
        try {
          const brokerMetadata = await broker.findGroupCoordinator({ groupId, coordinatorType })
          this.logger.debug('Found group coordinator', {
            broker: brokerMetadata.host,
            nodeId: brokerMetadata.coordinator.nodeId,
          })
          return brokerMetadata
        } catch (e) {
          this.logger.debug('Tried to find group coordinator', {
            nodeId,
            error: e,
          })

          if (e.type === 'GROUP_COORDINATOR_NOT_AVAILABLE') {
            this.logger.debug('Group coordinator not available, retrying...', {
              nodeId,
              retryCount,
              retryTime,
            })

            throw e
          }

          bail(e)
        }
      })
    })

    if (brokerMetadata) {
      return brokerMetadata
    }

    throw new KafkaJSGroupCoordinatorNotFound('Failed to find group coordinator')
  }

  /**
   * @param {object} topicConfiguration
   * @returns {number}
   */
  defaultOffset({ fromBeginning }) {
    return fromBeginning ? EARLIEST_OFFSET : LATEST_OFFSET
  }

  /**
   * @public
   * @param {Array<Object>} topics
   *                          [
   *                            {
   *                              topic: 'my-topic-name',
   *                              partitions: [{ partition: 0 }],
   *                              fromBeginning: false
   *                            }
   *                          ]
   * @returns {Promise<Array>} example:
   *                          [
   *                            {
   *                              topic: 'my-topic-name',
   *                              partitions: [
   *                                { partition: 0, offset: '1' },
   *                                { partition: 1, offset: '2' },
   *                                { partition: 2, offset: '1' },
   *                              ],
   *                            },
   *                          ]
   */
  async fetchTopicsOffset(topics) {
    const partitionsPerBroker = {}
    const topicConfigurations = {}

    const addDefaultOffset = topic => partition => {
      const { fromBeginning } = topicConfigurations[topic]
      return { ...partition, timestamp: this.defaultOffset({ fromBeginning }) }
    }

    // Index all topics and partitions per leader (nodeId)
    for (let topicData of topics) {
      const { topic, partitions, fromBeginning } = topicData
      const partitionsPerLeader = this.findLeaderForPartitions(
        topic,
        partitions.map(p => p.partition)
      )

      topicConfigurations[topic] = { fromBeginning }

      keys(partitionsPerLeader).map(nodeId => {
        partitionsPerBroker[nodeId] = partitionsPerBroker[nodeId] || {}
        partitionsPerBroker[nodeId][topic] = partitions.filter(p =>
          partitionsPerLeader[nodeId].includes(p.partition)
        )
      })
    }

    // Create a list of requests to fetch the offset of all partitions
    const requests = keys(partitionsPerBroker).map(async nodeId => {
      const broker = await this.findBroker({ nodeId })
      const partitions = partitionsPerBroker[nodeId]

      const { responses: topicOffsets } = await broker.listOffsets({
        isolationLevel: this.isolationLevel,
        topics: keys(partitions).map(topic => ({
          topic,
          partitions: partitions[topic].map(addDefaultOffset(topic)),
        })),
      })

      return topicOffsets
    })

    // Execute all requests, merge and normalize the responses
    const responses = await Promise.all(requests)
    const partitionsPerTopic = flatten(responses).reduce(mergeTopics, {})

    return keys(partitionsPerTopic).map(topic => ({
      topic,
      partitions: partitionsPerTopic[topic].map(({ partition, offset }) => ({
        partition,
        offset,
      })),
    }))
  }

  /**
   * Retrieve the object mapping for committed offsets for a single consumer group
   * @param {string} groupId
   * @returns {Object}
   */
  committedOffsets({ groupId }) {
    if (!this.committedOffsetsByGroup.has(groupId)) {
      this.committedOffsetsByGroup.set(groupId, {})
    }

    return this.committedOffsetsByGroup.get(groupId)
  }

  /**
   * Mark offset as committed for a single consumer group's topic-partition
   * @param {string} groupId
   * @param {string} topic
   * @param {string|number} partition
   * @param {string} offset
   * @returns {undefined}
   */
  markOffsetAsCommitted({ groupId, topic, partition, offset }) {
    const committedOffsets = this.committedOffsets({ groupId })

    committedOffsets[topic] = committedOffsets[topic] || {}
    committedOffsets[topic][partition] = offset
  }
}
