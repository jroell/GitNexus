import { GraphNode, GraphRelationship, KnowledgeGraph } from './types';

const buildKnowledgeGraph = (
  initialNodes: GraphNode[] = [],
  initialRelationships: GraphRelationship[] = [],
): KnowledgeGraph => {
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

  for (const node of initialNodes) addNode(node);
  for (const relationship of initialRelationships) addRelationship(relationship);

  return {
    nodes,
    relationships,
    get nodeCount() {
      return nodes.length;
    },
    get relationshipCount() {
      return relationships.length;
    },
    getNode: (id: string) => nodeMap.get(id),
    addNode,
    addRelationship,
  };
};

export const createKnowledgeGraph = (): KnowledgeGraph => buildKnowledgeGraph();

export const createKnowledgeGraphFromData = (
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): KnowledgeGraph => buildKnowledgeGraph(nodes, relationships);
