export function activate(api) {
  const neonCss = `body{--extension-accent:#8b5cf6}.send,.primary,.register-btn{background:linear-gradient(135deg,#8b5cf6,#5ac8fa)!important}.message.right{background:linear-gradient(135deg,#8b5cf6,#0a84ff)!important}`;
  api.theme.register({ id: 'neon-purple', name: 'Neon Purple', css: neonCss });
  api.ui.addButton({
    slot: 'sidebar.bottom',
    id: 'neon-theme',
    title: 'Neon Theme',
    onClick() {
      api.theme.apply('neon-purple');
      api.storage.set('activeTheme', 'neon-purple');
    },
  });
  api.ui.addSettingsSection({
    id: 'theme-pack-settings',
    title: 'Theme Pack',
    component() {
      return '<p class="muted">Adds the official Neon Purple theme and demonstrates api.theme.register().</p>';
    },
  });
  if (api.storage.get('activeTheme') === 'neon-purple') api.theme.apply('neon-purple');
}
