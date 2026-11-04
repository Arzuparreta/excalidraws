import { render } from 'solid-js/web';
import { Workspace } from './workspace/Workspace';
import './workspace/style.css';

// Serve all fonts locally, including Excalidraw's lazy-loaded handwriting fonts.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: '/excalidraw/' });
render(() => <Workspace />, document.getElementById('root')!);
