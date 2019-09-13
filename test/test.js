const path = require('path');

const delay = require('delay');
const ms = require('ms');
const test = require('ava');

const Bull = require('..');

test('returns itself', t => {
  const bull = new Bull();
  t.true(bull instanceof Bull);
});

test('init queue property', t => {
  const bull = new Bull();
  t.true(bull.queues instanceof Map);
});

test('config', t => {
  const bull = new Bull();
  t.true(typeof bull.config === 'object');
  t.true(bull.config.logger === console);
  t.true(Array.isArray(bull.config.queues));
});

test('job with file path processor', async t => {
  const bull = new Bull({
    queues: [
      {
        name: 'sitemap',
        options: {
          defaultJobOptions: {
            repeat: {
              cron: '* * * * *'
            }
          }
        },
        processors: [
          {
            processor: path.join(__dirname, 'helpers', 'processor.js')
          }
        ]
      }
    ]
  });
  // if it is a repeatable job then we must empty the queue first
  // <https://github.com/OptimalBits/bull/issues/742#issuecomment-340766873>
  const queue = bull.queues.get('sitemap');
  await t.notThrowsAsync(queue.empty());
  await t.notThrowsAsync(queue.add());
  await t.notThrowsAsync(bull.start());
  await delay(1000);
  const waitingCount = await queue.getWaitingCount();
  t.is(waitingCount, 0);
  await t.notThrowsAsync(bull.pause());
  await t.notThrowsAsync(bull.close());
});

test('job with callback processor', async t => {
  const bull = new Bull({
    queues: [
      {
        name: 'messenger',
        options: {
          defaultJobOptions: {
            repeat: {
              every: ms('1m')
            }
          }
        },
        processors: [
          {
            processor: (job, done) => {
              done(null, job.id);
            }
          }
        ]
      }
    ]
  });

  const queue = bull.queues.get('messenger');
  await t.notThrowsAsync(queue.empty());
  await t.notThrowsAsync(
    queue.add({
      jobId: 'messenger',
      repeat: {
        every: ms('1m')
      }
    })
  );
  await t.notThrowsAsync(bull.start());
  await delay(1000);
  const waitingCount = await queue.getWaitingCount();
  t.is(waitingCount, 0);
  await t.notThrowsAsync(bull.pause());
  await t.notThrowsAsync(bull.close());
});

test('job with async processor', async t => {
  const bull = new Bull({
    queues: [
      {
        name: 'email',
        processors: [
          {
            processor: async job => {
              await delay(500);
              return job.id;
            },
            concurrency: 3
          },
          {
            name: 'sendgrid',
            processor: async job => {
              // this is an email job example that is processed differently
              // because we want to use "sendgrid" as our transport instead
              // of the normal default transport provider
              //
              // note that this could also be specific in the job options
              // (e.g. `queue.add({ transport: 'sendgrid' })`)
              // however we are putting this here as an example
              await delay(500);
              return job.id;
            },
            concurrency: 1
          }
        ]
      }
    ]
  });
  const queue = bull.queues.get('email');
  await t.notThrowsAsync(queue.empty());
  await t.notThrowsAsync(
    Promise.all([
      queue.add(
        {
          template: 'test',
          to: 'test@test.com'
        },
        {
          attempts: 1
        }
      ),
      queue.add('sendgrid', {
        template: 'test',
        to: 'test@test.com'
      })
    ])
  );
  await t.notThrowsAsync(bull.start());
  await delay(1000);
  const waitingCount = await queue.getWaitingCount();
  t.is(waitingCount, 0);
  await t.notThrowsAsync(bull.pause());
  await t.notThrowsAsync(bull.close());
});
