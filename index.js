const Queue = require('bull');
const Redis = require('@ladjs/redis');
const _ = require('lodash');
const autoBind = require('auto-bind');
const isSANB = require('is-string-and-not-blank');
const sharedConfig = require('@ladjs/shared-config');

const conf = _.pick(sharedConfig('BULL'), ['logger', 'redis', 'redisMonitor']);

class Bull {
  constructor(config = {}) {
    this.config = _.merge(
      {
        ...conf,
        logger: console,
        processors: {},
        concurrency: 1,
        queues: [],
        queue: {
          prefix: `bull_${(
            process.env.NODE_ENV || 'development'
          ).toLowerCase()}`
        },
        queueMaxListeners: 15
      },
      config
    );

    this.config.queue = _.merge(
      // <https://github.com/OptimalBits/bull/blob/develop/REFERENCE.md#queue>
      {
        redis: this.config.redis,
        // <https://github.com/OptimalBits/bull/blob/develop/PATTERNS.md#reusing-redis-connections>
        // <https://github.com/OptimalBits/bull/blob/develop/lib/queue.js#L164>
        // createClient: (type, config) => {
        createClient: type => {
          this.config.logger.debug('creating bull client', { type });
          switch (type) {
            case 'client':
              return this.client;
            case 'subscriber':
              return this.eclient;
            default:
              return this.bclient;
          }
        }
      },
      this.config.queue
    );

    this.client = new Redis(
      this.config.queue.redis,
      this.config.logger,
      this.config.redisMonitor
    );

    this.eclient = new Redis(
      this.config.queue.redis,
      this.config.logger,
      this.config.redisMonitor
    );

    this.bclient = new Redis(
      this.config.queue.redis,
      this.config.logger,
      this.config.redisMonitor
    );

    // Map<key, Queue>
    // key: queue name
    // value: bull Queue
    this.queues = new Map();

    // Map<key, processors>
    // key: queue name
    // value: bull processors
    this.processors = new Map();

    // Queue#process
    // Queue#add
    // Queue#pause
    // Queue#resume
    // Queue#count
    // Queue#empty
    // Queue#clean
    // Queue#close
    // Queue#getJob
    // Queue#getJobs
    // Queue#getJobLogs
    // Queue#getRepeatableJobs
    // Queue#removeRepeatable
    // Queue#removeRepeatableByKey
    // Queue#getJobCounts
    // Queue#getCompletedCount
    // Queue#getFailedCount
    // Queue#getDelayedCount
    // Queue#getActiveCount
    // Queue#getWaitingCount
    // Queue#getPausedCount
    // Queue#getWaiting
    // Queue#getActive
    // Queue#getDelayed
    // Queue#getCompleted
    // Queue#getFailed
    [
      'process',
      'add',
      'pause',
      'resume',
      'count',
      'empty',
      'clean',
      'close',
      'getJob',
      'getJobs',
      'getJobLogs',
      'getRepeatableJobs',
      'removeRepeatable',
      'removeRepeatableByKey',
      'getJobCounts',
      'getCompletedCount',
      'getFailedCount',
      'getDelayedCount',
      'getActiveCount',
      'getWaitingCount',
      'getPausedCount',
      'getWaiting',
      'getActive',
      'getDelayed',
      'getCompleted',
      'getFailed'
    ].forEach(method => {
      this[method] = async (name, ...args) => {
        if (!isSANB(name))
          return Promise.all(
            [...this.queues.keys()].map(key => this[method](key, ...args))
          );

        const queue = this.queues.get(name);
        if (!queue) throw new Error(`Queue "${name}" does not exist`);
        this.config.logger.debug(method, this.getMeta({ queue, args }));
        return queue[method](...args);
      };
    });

    // alias stop <-> close
    this.stop = this.close;

    // bind `this` to all methods
    autoBind(this);

    // create queues based off options passed
    for (let i = 0; i < this.config.queues.length; i++) {
      const queue = this.config.queues[i];
      if (!isSANB(queue.name))
        throw new Error(`Queue #${i + 1} is missing a 'name' (String)`);
      if (!Array.isArray(queue.processors) || queue.processors.length === 0)
        throw new Error(
          `Queue "${queue.name}" is missing 'processors' (Array, length must be at least 1)`
        );
      for (let p = 0; p < queue.processors.length; p++) {
        if (
          !_.isObject(queue.processors[p]) ||
          Array.isArray(queue.processors[p])
        )
          throw new Error(
            `Queue name "${queue.name}" processor #${p + 1} must be an Object`
          );
        if (
          !_.isString(queue.processors[p].processor) &&
          !_.isFunction(queue.processors[p].processor)
        )
          throw new Error(
            `Queue name "${queue.name}" processor #${p +
              1} is missing a 'processor' (String or Function)`
          );
      }

      const q = new Queue(
        queue.name,
        _.merge({
          ...this.config.queue,
          ...queue.options
        })
      );
      this._registerEvents(q);
      this.queues.set(queue.name, q);
      this.processors.set(queue.name, queue.processors);
    }
  }

  async start(name) {
    if (!isSANB(name)) {
      this.config.logger.debug('starting up all job queues');
      return Promise.all([...this.queues.keys()].map(key => this.start(key)));
    }

    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" does not exist`);
    this.config.logger.debug('starting up job queue', this.getMeta({ queue }));

    const processors = this.processors.get(name);
    if (!processors)
      throw new Error(`Queue "${name}" did not have any processors`);

    for (const element of processors) {
      queue.process(
        element.name || '*',
        element.concurrency || this.config.concurrency,
        element.processor
      );
    }

    return this.resume(name);
  }

  // get meta information about the queue for logging purposes
  getMeta(opts) {
    if (!opts.queue && opts.job && opts.job.queue) opts.queue = opts.job.queue;
    if (!opts.queue) throw new Error('getMeta must be passed opts.queue');
    return {
      ...opts,
      queue: _.pick(opts.queue, [
        'name',
        'token',
        'keyPrefix',
        'retrieving',
        'drained'
      ]),
      ...(opts.job
        ? { job: _.omitBy(_.omit(opts.job, 'queue'), val => _.isFunction(val)) }
        : {})
    };
  }

  // <https://github.com/OptimalBits/bull/blob/develop/REFERENCE.md#events>
  _registerEvents(queue) {
    // <https://github.com/OptimalBits/bull/blob/ce5c91dcef9e8d064406946987e8ed31babbfe39/lib/queue.js#L456-L476
    /*
    if (!this.registeredEvents[_eventName]) {
      return utils
        .isRedisReady(this.eclient)
        .then(() => {
          const channel = this.toKey(_eventName);
          if (['active', 'waiting', 'stalled'].indexOf(_eventName) !== -1) {
            return (this.registeredEvents[_eventName] = this.eclient.psubscribe(
              channel + '*'
            ));
          } else {
            return (this.registeredEvents[_eventName] = this.eclient.subscribe(
              channel
            ));
          }
        })
        .then(() => {
          this.emit('registered:' + eventName);
        });
    } else {
      return this.registeredEvents[_eventName];
    }
    */

    // <https://github.com/OptimalBits/bull/issues/1659>
    queue.removeAllListeners('error');
    queue.setMaxListeners(this.config.queueMaxListeners);

    queue
      .on('error', err => {
        this.config.logger.error(err, this.getMeta({ queue }));
      })

      .on('waiting', jobId => {
        // A Job is waiting to be processed as soon as a worker is idling.
        this.config.logger.debug(
          'queue waiting',
          this.getMeta({ queue, job: { id: jobId } })
        );
      })

      // .on('active', (job, jobPromise) => {
      .on('active', job => {
        // A job has started. You can use `jobPromise.cancel()`` to abort it.
        this.config.logger.debug('queue active', this.getMeta({ queue, job }));
      })

      .on('stalled', job => {
        // A job has been marked as stalled. This is useful for debugging job
        // workers that crash or pause the event loop.
        this.config.logger.debug('queue stalled', this.getMeta({ queue, job }));
      })

      .on('progress', (job, progress) => {
        // A job's progress was updated!
        this.config.logger.debug(
          'queue progress',
          this.getMeta({ queue, job, progress })
        );
      })

      .on('completed', (job, result) => {
        // A job successfully completed with a `result`.
        this.config.logger.debug(
          'queue completed',
          this.getMeta({ queue, job, result })
        );
      })

      .on('failed', (job, err) => {
        // A job failed with reason `err`!
        this.config.logger.error(err, this.getMeta({ queue, job }));
      })

      .on('paused', () => {
        // The queue has been paused.
        this.config.logger.debug('queue paused', this.getMeta({ queue }));
      })

      .on('resumed', job => {
        // The queue has been resumed.
        this.config.logger.debug('queue resumed', this.getMeta({ queue, job }));
      })

      .on('cleaned', (jobs, type) => {
        // Old jobs have been cleaned from the queue. `jobs` is an array of cleaned
        // jobs, and `type` is the type of jobs cleaned.
        this.config.logger.debug(
          'queue cleaned',
          this.getMeta({ queue, jobs, type })
        );
      })

      .on('drained', () => {
        // Emitted every time the queue has processed all the waiting jobs (even if there can be some delayed jobs not yet processed)
        this.config.logger.debug('queue drained', this.getMeta({ queue }));
      })

      .on('removed', job => {
        // A job successfully removed.
        this.config.logger.debug('queue removed', this.getMeta({ queue, job }));
      });
  }
}

module.exports = Bull;
