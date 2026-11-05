import { normalizeDn, parentDn } from "./dn";
import type { OuNode } from "./directory/types";

export interface TreeNode extends OuNode {
  depth: number;
  children: TreeNode[];
}

/** Builds a tree from a flat container list. Nodes whose parent is missing hang off the root. */
export function buildOuTree(nodes: OuNode[]): TreeNode[] {
  const byKey = new Map<string, TreeNode>();
  for (const n of nodes) byKey.set(normalizeDn(n.dn), { ...n, depth: 0, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byKey.values()) {
    const p = parentDn(node.dn);
    const parent = p ? byKey.get(normalizeDn(p)) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: TreeNode[], depth: number) => {
    list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "container" ? 1 : -1));
    for (const n of list) {
      n.depth = depth;
      sortRec(n.children, depth + 1);
    }
  };
  sortRec(roots, 0);
  return roots;
}

export function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
