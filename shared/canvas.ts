/*
 * Every item in the library is a canvas. A canvas can contain other canvases.
 *
 * On disk, the canvas `Ideas.excalidraw` keeps the canvases inside it in the sibling
 * folder `Ideas/`. That folder exists only while the canvas has canvases inside it.
 * A folder without its `.excalidraw` file is still a canvas: it is shown empty and
 * its file is written the first time it is saved.
 *
 * A canvas is identified by the vault path of its file, such as `Ideas/Idea A.excalidraw`.
 * The folder that holds the canvases inside it is that path without the extension.
 */
export const EXTENSION = '.excalidraw';

/** The folder that holds the canvases inside `path`: the path without its extension. */
export const childFolder = (path: string) =>
  path.endsWith(EXTENSION) ? path.slice(0, -EXTENSION.length) : path;
/** The canvas whose folder is `folder` ('' is the top level of the library). */
export const folderCanvas = (folder: string) => (folder ? `${folder}${EXTENSION}` : '');
/** The folder that contains `path` ('' is the top level). */
export const folderOf = (path: string) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
/** The canvas that contains `path`, or '' at the top level. */
export const parentCanvas = (path: string) => folderCanvas(folderOf(path));
/** The canvases that contain `path`, nearest first. */
export const ancestorCanvases = (path: string) => {
  const result: string[] = [];
  for (let current = parentCanvas(path); current; current = parentCanvas(current))
    result.push(current);
  return result;
};
/** Path of a canvas named `name` inside `parent` ('' is the top level). */
export const canvasPath = (parent: string, name: string) => {
  const folder = parent ? childFolder(parent) : '';
  return `${folder ? `${folder}/` : ''}${name}${EXTENSION}`;
};
/** The canvas name shown to people: the file name without its extension. */
export const canvasName = (path: string) => {
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  return leaf.endsWith(EXTENSION) ? leaf.slice(0, -EXTENSION.length) : leaf;
};
/** True when `path` is the canvas `root` itself or any canvas inside it. */
export const inCanvas = (path: string, root: string) =>
  !!root && (path === root || path.startsWith(`${childFolder(root)}/`));
/** Where `path` ends up when the canvas `from` moves to `to`, together with its contents. */
export const relocated = (path: string, from: string, to: string) => {
  if (path === from) return to;
  const folder = `${childFolder(from)}/`;
  return path.startsWith(folder) ? `${childFolder(to)}/${path.slice(folder.length)}` : path;
};
/** Removes duplicates and canvases already included by a selected ancestor. */
export const outermost = (paths: Iterable<string>) => {
  const unique = [...new Set([...paths].filter(Boolean))];
  return unique.filter((path) => !unique.some((other) => other !== path && inCanvas(path, other)));
};

/*
 * Links between canvases are element links in the scene: `/?canvas=Ideas/Idea%20A.excalidraw`.
 * They are relative so they keep working on any host the service is reached from. Slashes
 * stay readable; everything else is percent-encoded so names with `+`, `&` or `#` survive.
 */
const LINK_BASE = 'http://excalidraws.invalid';
export const canvasLink = (path: string) =>
  `/?canvas=${encodeURIComponent(path).replace(/%2F/g, '/')}`;
/**
 * The canvas a link opens, or undefined for any other link. Relative links are canvas links
 * when they carry `canvas`; absolute links only when they belong to `origin`.
 */
export const linkedCanvas = (link: unknown, origin?: string) => {
  if (typeof link !== 'string' || !link) return undefined;
  const relative = link.startsWith('/') && !link.startsWith('//');
  if (!relative && !origin) return undefined;
  try {
    const url = new URL(link, LINK_BASE);
    if (!relative && url.origin !== origin) return undefined;
    const path = url.searchParams.get('canvas');
    return path && path.endsWith(EXTENSION) ? path : undefined;
  } catch {
    return undefined;
  }
};
/** Element links found in a list of scene elements. */
export const sceneLinks = (elements: readonly unknown[]) => {
  const links: string[] = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const value = element as { link?: unknown; isDeleted?: unknown };
    if (value.isDeleted !== true && typeof value.link === 'string' && value.link)
      links.push(value.link);
  }
  return links;
};
/**
 * The link to store after the canvas `from` moved to `to`, or undefined when `link` does
 * not point into the moved canvas. Only relative canvas links are rewritten.
 */
export const relocatedLink = (link: string, from: string, to: string) => {
  const target = linkedCanvas(link);
  if (!target || !inCanvas(target, from)) return undefined;
  const next = canvasLink(relocated(target, from, to));
  return next === link ? undefined : next;
};
