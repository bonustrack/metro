export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;

export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '', children: [], text: '' };
  const stack: XmlNode[] = [root];
  for (const m of text.matchAll(TOKEN)) {
    const top = stack[stack.length - 1] ?? root;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const node: XmlNode = { name: m[3], children: [], text: '' };
      top.children.push(node);
      if (m[5] === '') stack.push(node);
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6]);
  }
  return root.children[0] ?? root;
}

export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((c) => c.name === name);

export const children = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node?.children.filter((c) => c.name === name) ?? [];

export function textAt(node: XmlNode | undefined, ...path: string[]): string {
  let at = node;
  for (const name of path) at = child(at, name);
  return at?.text.trim() ?? '';
}
