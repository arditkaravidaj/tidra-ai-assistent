import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: 'dist',
  manifest: {
    name: 'Tidra',
    description:
      'Your AI assistant in the browser — summarizes pages, answers about content, helps everywhere.',
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    // "alarms" is what makes long batch jobs survivable: the service worker is
    // killed after ~30s idle, and the alarm is what wakes it back up to carry
    // on from where the job's stored state left off.
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'tabs',
      'favicon',
      'webNavigation',
      'unlimitedStorage',
      'alarms',
      // Voice input records in an offscreen document, because a content script
      // would have to borrow the host page's microphone permission.
      'offscreen',
      // Saving a generated PDF or an image off a page. A service worker has no
      // DOM, so an <a download> is not available to it — this API is the only
      // way the background can put a file on disk.
      'downloads',
    ],
    // <all_urls> is what the content script already matches; it additionally
    // lets the background enumerate frames and capture the tab for the vision
    // fallback when the accessibility tree isn't enough. The Groq API is
    // reached from the background, which <all_urls> already covers.
    host_permissions: ['<all_urls>'],
    commands: {
      'toggle-island': {
        suggested_key: {
          default: 'Ctrl+Shift+Space',
          mac: 'Command+Shift+Space',
        },
        description: 'Open/close Tidra',
      },
    },
  },
});
