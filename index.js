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
        queue: {}
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
          !_.isObject(queue.processors[i]) ||
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
    if (!name) {
      this.config.logger.info('starting up all job queues');
      return Promise.all([...this.queues.keys()].map(key => this.start(key)));
    }

    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" does not exist`);
    this.config.logger.info(`starting up job queue`, this._getMeta({ queue }));

    const processors = this.processors.get(name);
    if (!processors)
      throw new Error(`Queue "${name}" did not have any processors`);

    for (let p = 0; p < processors.length; p++) {
      queue.process(
        processors[p].name || '*',
        processors[p].concurrency || this.config.concurrency,
        processors[p].processor
      );
    }

    return this.resume(name);
  }

  async resume(name) {
    if (!name) {
      this.config.logger.info('resuming all job queues');
      return Promise.all([...this.queues.keys()].map(key => this.resume(key)));
    }

    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" does not exist`);
    this.config.logger.info(`resuming job queue`, this._getMeta({ queue }));
    return queue.resume();
  }

  async pause(name) {
    if (!name) {
      this.config.logger.info('pausing all job queues');
      return Promise.all([...this.queues.keys()].map(key => this.pause(key)));
    }

    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" does not exist`);
    this.config.logger.info(`pausing job queue`, this._getMeta({ queue }));
    return queue.pause();
  }

  // graceful shutdown
  async stop(name) {
    if (!name) {
      this.config.logger.info('shutting down all job queues');
      return Promise.all([...this.queues.keys()].map(key => this.stop(key)));
    }

    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" does not exist`);
    this.config.logger.info(
      `shutting down job queue`,
      this._getMeta({ queue })
    );
    return queue.close();
  }

  // get meta information about the queue for logging purposes
  _getMeta(opts) {
    if (!opts.queue) throw new Error('_getMeta must be passed opts.queue');
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
    queue
      .on('error', err => {
        this.config.logger.error(err, this._getMeta({ queue }));
      })

      .on('waiting', jobId => {
        // A Job is waiting to be processed as soon as a worker is idling.
        this.config.logger.debug(
          'queue waiting',
          this._getMeta({ queue, job: { id: jobId } })
        );
      })

      // .on('active', (job, jobPromise) => {
      .on('active', job => {
        // A job has started. You can use `jobPromise.cancel()`` to abort it.
        this.config.logger.debug('queue active', this._getMeta({ queue, job }));
      })

      .on('stalled', job => {
        // A job has been marked as stalled. This is useful for debugging job
        // workers that crash or pause the event loop.
        this.config.logger.debug(
          'queue stalled',
          this._getMeta({ queue, job })
        );
      })

      .on('progress', (job, progress) => {
        // A job's progress was updated!
        this.config.logger.debug(
          'queue progress',
          this._getMeta({ queue, job, progress })
        );
      })

      .on('completed', (job, result) => {
        // A job successfully completed with a `result`.
        this.config.logger.debug(
          'queue completed',
          this._getMeta({ queue, job, result })
        );
      })

      .on('failed', (job, err) => {
        // A job failed with reason `err`!
        this.config.logger.error(err, this._getMeta({ queue, job }));
      })

      .on('paused', () => {
        // The queue has been paused.
        this.config.logger.debug('queue paused', this._getMeta({ queue }));
      })

      .on('resumed', job => {
        // The queue has been resumed.
        this.config.logger.debug(
          'queue resumed',
          this._getMeta({ queue, job })
        );
      })

      .on('cleaned', (jobs, type) => {
        // Old jobs have been cleaned from the queue. `jobs` is an array of cleaned
        // jobs, and `type` is the type of jobs cleaned.
        this.config.logger.debug(
          'queue cleaned',
          this._getMeta({ queue, jobs, type })
        );
      })

      .on('drained', () => {
        // Emitted every time the queue has processed all the waiting jobs (even if there can be some delayed jobs not yet processed)
        this.config.logger.debug('queue drained', this._getMeta({ queue }));
      })

      .on('removed', job => {
        // A job successfully removed.
        this.config.logger.debug(
          'queue removed',
          this._getMeta({ queue, job })
        );
      });
  }
}

module.exports = Bull;
