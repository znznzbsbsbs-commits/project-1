const { permissions, level, describe } = require('../extensions/permissions');
const { validateManifest } = require('../extensions/manifest');
const { createEventBus } = require('../core/events');
const { createNamespacedStorage } = require('../core/storage');
const { createExtensionNetwork } = require('../core/network');
module.exports = { permissions, permissionLevel: level, describePermission: describe, validateManifest, createEventBus, createNamespacedStorage, createExtensionNetwork };
