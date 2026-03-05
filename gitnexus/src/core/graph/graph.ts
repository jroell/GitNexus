import { GraphNode, GraphRelationship, KnowledgeGraph } from './types.js'

export const createKnowledgeGraph = (): KnowledgeGraph => {
  const nodeMap = new Map<string, GraphNode>();
  const relationshipMap = new Map<string, GraphRelationship>();
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  const addNode = (node: GraphNode) => {
    if (nodeMap.has(node.id)) return;
    nodeMap.set(node.id, node);
    nodes.push(node);
  };

  const addRelationship = (relationship: GraphRelationship) => {
    if (relationshipMap.has(relationship.id)) return;
    relationshipMap.set(relationship.id, relationship);
    relationships.push(relationship);
  };

  /**
   * Remove a single node and all relationships involving it
   */
  const removeNode = (nodeId: string): boolean => {
    if (!nodeMap.has(nodeId)) return false;
    
    nodeMap.delete(nodeId);
    const nodeIdx = nodes.findIndex(node => node.id === nodeId);
    if (nodeIdx !== -1) nodes.splice(nodeIdx, 1);
    
    // Remove all relationships involving this node
    for (let i = relationships.length - 1; i >= 0; i--) {
      const rel = relationships[i];
      if (rel.sourceId === nodeId || rel.targetId === nodeId) {
        relationshipMap.delete(rel.id);
        relationships.splice(i, 1);
      }
    }
    return true;
  };

  /**
   * Remove all nodes (and their relationships) belonging to a file
   */
  const removeNodesByFile = (filePath: string): number => {
    let removed = 0;
    for (const [nodeId, node] of nodeMap) {
      if (node.properties?.filePath === filePath) {
        removeNode(nodeId);
        removed++;
      }
    }
    return removed;
  };

  return{
    nodes,
    relationships,

    iterNodes: () => nodeMap.values(),
    iterRelationships: () => relationshipMap.values(),
    forEachNode(fn: (node: GraphNode) => void) { nodeMap.forEach(fn); },
    forEachRelationship(fn: (rel: GraphRelationship) => void) { relationshipMap.forEach(fn); },
    getNode: (id: string) => nodeMap.get(id),

    // O(1) count getters - avoid creating arrays just for length
    get nodeCount() {
      return nodes.length;
    },

    get relationshipCount() {
      return relationships.length;
    },

    addNode,
    addRelationship,
    removeNode,
    removeNodesByFile,

  };
};
