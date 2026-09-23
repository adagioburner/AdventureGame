// PixiJS compiles its shaders' uniform uploads with `new Function` unless this
// is loaded first. With it, the renderer runs under a content security policy
// that forbids eval, which is what lets the viewer be published as a page.
import 'pixi.js/unsafe-eval';
import { createRoot } from 'react-dom/client';
import { App } from './page/App.tsx';

const host = document.getElementById('app');
if (host === null) throw new Error('index.html has no #app');
createRoot(host).render(<App />);
