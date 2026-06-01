const permissions = {
  safe: ['ui', 'storage', 'commands', 'notifications', 'events', 'theme'],
  sensitive: ['network', 'voice', 'video', 'call-events'],
  critical: ['microphone', 'camera', 'screenshare', 'filesystem', 'desktop', 'admin'],
};
function level(permission) {
  if (permissions.critical.includes(permission)) return 'critical';
  if (permissions.sensitive.includes(permission)) return 'sensitive';
  return 'safe';
}
function describe(permission) {
  return {
    ui: 'Может добавлять кнопки, страницы и секции настроек',
    storage: 'Может хранить собственные настройки расширения',
    commands: 'Может регистрировать команды',
    notifications: 'Может показывать уведомления',
    events: 'Может подписываться на события приложения',
    theme: 'Может регистрировать темы оформления',
    network: 'Может обращаться к внешним сервисам через разрешённый SDK',
    voice: 'Может вызывать высокоуровневые голосовые действия',
    video: 'Может вызывать высокоуровневые видео действия',
    'call-events': 'Может получать события звонков',
    microphone: 'Может управлять mute/unmute без доступа к raw audio',
    camera: 'Может включать/выключать камеру без raw video доступа',
    screenshare: 'Может запускать демонстрацию экрана через Core API',
    filesystem: 'Критический доступ к файловому слою Electron через bridge',
    desktop: 'Критический доступ к desktop bridge',
    admin: 'Критические административные функции',
  }[permission] || permission;
}
module.exports = { permissions, level, describe };
