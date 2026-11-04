import { createRoot } from 'react-dom/client';
import { Workspace } from './workspace/Workspace';
import './workspace/style.css';

// Serve all fonts locally, including Excalidraw's lazy-loaded handwriting fonts.
Object.assign(window, { EXCALIDRAW_ASSET_PATH: '/excalidraw/' });
createRoot(document.getElementById('root')!).render(<Workspace />);
