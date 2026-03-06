# Queue Processing

Cloudflare Workers natively allow only **one** `queue()` handler per worker. Bobra overcomes this limitation by implementing a built-in **Queue Dispatcher** that allows you to manage multiple logical queues within a single worker.

## The Workaround: Queue Multiplexing

Bobra's `createCloudflareWorker` entry point exports a singular `queue()` handler to the runtime. When a batch arrives, Bobra inspects the `batch.queue` property to determine which logical queue the messages belong to and dispatches them to the appropriate `AppHandler`.

### How it Works
1.  **Multiple Consumers**: You configure multiple queue consumers for a single worker in your `config.yml`.
2.  **Handler Matchers**: Each handler can define a `handlesQueue` predicate.
3.  **Dynamic Dispatch**: The framework iterates through all registered handlers and executes those that claim they can handle the incoming queue name.

## Implementation Guide

### 1. Configure Queues
In your `config.yml`, define the queues the worker should consume:

```yaml
workers:
  processing-worker:
    queues:
      consumers:
        - queue: "USERS_SYNC_QUEUE"
          max_batch_size: 10
        - queue: "NOTIFICATION_QUEUE"
          max_batch_size: 5
```

### 2. Define the Queue Handler
In your handler file (e.g., `src/index.ts`), implement the `queue` and `handlesQueue` properties:

```typescript
import { AppHandler } from '@danylohotvianskyi/bobra-framework';

export const userProcessingHandler: AppHandler = {
  name: 'user-processing',
  version: '1.0.0',
  routes: new Hono(),
  
  // The processing logic
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      console.log(`Processing message from ${batch.queue}:`, message.body);
      // Your logic here
      message.ack();
    }
  },

  // The matcher: returns true if this handler should handle this queue
  handlesQueue: (queueName) => queueName === 'USERS_SYNC_QUEUE'
};
```

### 3. Register the Handler
Register the handler as usual. When the worker starts, Bobra will automatically include it in the dispatch table.

```typescript
const worker = await createWorker(env);
await worker.add(userProcessingHandler);
await worker.add(notificationHandler); // Can handle separate queues in the same worker
```

## Advanced Dispatching

### Multiple Matchers
If multiple handlers match the same `queueName`, Bobra will execute them **sequentially** for the same batch. This allows you to split logic across specialized handlers for the same data stream.

### Fallback Behavior
If a handler implements `queue` but **not** `handlesQueue`, it is treated as a catch-all for any queues not explicitly handled by other matchers. If multiple such fallback handlers exist, the framework will use the first one registered and issue a warning.

## Key Interfaces

### `QueueBatch`
The `batch` object passed to your `queue` function contains:
- `queue`: The name of the queue.
- `messages`: An array of `Message` objects.
- `retryAll()`: Retries all messages in the batch.

### `Message`
Each message in `batch.messages` contains:
- `id`: Unique message ID.
- `timestamp`: When the message was sent.
- `body`: The actual payload (JSON or string).
- `ack()`: Acknowledges successful processing.
- `retry()`: Explicitly requests a retry for this specific message.
