function createEventBus() {
  const listeners = new Map();
  return {
    on(eventName, callback) {
      const bucket = listeners.get(eventName) || new Set();
      bucket.add(callback);
      listeners.set(eventName, bucket);
      return () => bucket.delete(callback);
    },
    emit(eventName, payload) {
      for (const callback of listeners.get(eventName) || []) callback(payload);
    },
    clear() { listeners.clear(); },
  };
}
module.exports = { createEventBus };
