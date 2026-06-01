export function activate(api) {
  api.commands.register({ id: 'open.files', title: 'Open files', execute: () => api.events.emit('core-tools.files') });
  api.commands.register({ id: 'call.mute', title: 'Mute microphone', execute: () => api.calls.mute() });
  api.commands.register({ id: 'call.camera', title: 'Toggle camera off', execute: () => api.calls.disableCamera() });
  api.commands.register({ id: 'call.screen', title: 'Start screen share', execute: () => api.calls.startScreenShare() });

  api.ui.addButton({
    slot: 'header.right',
    id: 'commands',
    title: 'Commands',
    onClick() {
      const commands = api.commands.list().map(item => item.title).join('\n');
      api.notifications.show('Core Tools', commands || 'Команды появятся после активации расширений с разрешением commands');
    },
  });
  api.ui.addButton({ slot: 'toolbar', id: 'mute', title: 'Mute', onClick: () => api.calls.mute() });
  api.ui.addPage({
    id: 'commands-page',
    title: 'Core Tools',
    route: '/extensions/core-tools',
    component() {
      return `<div class="extension-card"><p>Registered commands: ${api.commands.list().length}</p><p>This official extension provides reusable command buttons and safe call actions through the public SDK.</p></div>`;
    },
  });
  api.ui.addSettingsSection({
    id: 'core-tools-settings',
    title: 'Core Tools',
    component() {
      return '<p class="muted">Core Tools adds command palette examples and safe high-level call actions.</p>';
    },
  });
}

export function deactivate() {}
