// core/event-bus.js
// APEX Internal Event Bus — agents communicate through here
import { EventEmitter } from 'events';

class ApexEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // APEX has 30+ agents — each registers a broadcast listener
    this._history = [];
    this._maxHistory = 1000;
  }

  emit(event, data) {
    const entry = {
      ts: Date.now(),
      event,
      data,
    };
    this._history.push(entry);
    if (this._history.length > this._maxHistory) this._history.shift();
    return super.emit(event, data);
  }

  // Get recent events by type
  recent(eventType, limit = 10) {
    return this._history
      .filter(e => e.event === eventType)
      .slice(-limit);
  }

  // Broadcast to all agents
  broadcast(data) {
    this.emit('broadcast', data);
  }
}

export const bus = new ApexEventBus();
export default bus;
