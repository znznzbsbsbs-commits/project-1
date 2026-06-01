function createNamespacedStorage(prefix, storage = globalThis.localStorage) {
  return {
    get(key) { return JSON.parse(storage.getItem(`${prefix}:${key}`) || 'null'); },
    set(key, value) { storage.setItem(`${prefix}:${key}`, JSON.stringify(value)); },
    remove(key) { storage.removeItem(`${prefix}:${key}`); },
  };
}
module.exports = { createNamespacedStorage };
