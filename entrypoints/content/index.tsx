import ReactDOM from 'react-dom/client';
import { Island } from './Island';
import { registerActions } from './actions';
import './font.css';
import './island.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Runs in every frame so the agent can reach elements inside cross-origin
  // iframes (embedded editors, payment widgets, chat panels) — those are
  // invisible to the top frame's DOM walk. Only the top frame renders the UI.
  allFrames: true,
  cssInjectionMode: 'ui',

  async main(ctx) {
    registerActions();

    const isTop = window.top === window.self;
    if (!isTop) return; // sub-frames act, they don't render

    // Report this visit for routine learning (domain + time only; no page text).
    try {
      const domain = location.hostname;
      if (domain && location.protocol.startsWith('http')) {
        browser.runtime.sendMessage({ type: 'tidra-visit', domain }).catch(() => {});
      }
    } catch {}

    const ui = await createShadowRootUi(ctx, {
      name: 'tidra-island',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        const root = ReactDOM.createRoot(container);
        root.render(<Island />);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
