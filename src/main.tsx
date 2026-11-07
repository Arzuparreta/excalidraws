import { render } from 'solid-js/web';
import { Workspace } from './workspace/Workspace';
import './workspace/style.css';

render(() => <Workspace />, document.getElementById('root')!);
