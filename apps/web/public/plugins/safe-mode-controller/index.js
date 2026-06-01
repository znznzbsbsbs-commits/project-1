export function activate(api) {
  api.ui.addSettingsSection({
    id: 'safe-mode',
    title: 'Safe Mode Controller',
    component() {
      return '<p class="muted">If an extension breaks the UI, open Settings -> Extensions and enable Safe Mode. Files stay installed but plugin activation is skipped.</p>';
    },
  });
  api.events.on('extensions.ready', payload => api.notifications.show('Extensions ready', `${payload.count} active extensions`));
}
