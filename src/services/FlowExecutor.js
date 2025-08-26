import logger from '../utils/logger.js';

/**
 *
 */
class FlowExecutor {
  /**
   *
   */
  constructor() {
    this.flowDataStore = new Map();
  }

  // Store flow data for a session
  /**
   *
   * @param sessionId
   * @param nodes
   * @param edges
   */
  setFlowData(sessionId, nodes, edges) {
    this.flowDataStore.set(sessionId, {
      nodes: nodes || [],
      edges: edges || [],
      updatedAt: new Date().toISOString(),
    });
    logger.info(`Flow data stored for session ${sessionId}`, {
      nodeCount: nodes?.length || 0,
      edgeCount: edges?.length || 0,
    });
  }

  // Get flow data for a session
  /**
   *
   * @param sessionId
   */
  getFlowData(sessionId) {
    return this.flowDataStore.get(sessionId);
  }

  /**
   * Find the start node in the flow
   * @param {Array} nodes - Array of flow nodes
   * @returns {Object|null} - The start node or null
   */
  findStartNode(nodes) {
    return nodes.find(
      (node) =>
        node.type === 'startNode' ||
        node.data?.label?.toLowerCase().includes('inicio') ||
        node.data?.label?.toLowerCase().includes('start'),
    );
  }

  /**
   * Process a single node
   * @param {Object} node - Node to process
   * @param {string} message - User message
   * @param {Array} edges - Flow edges
   * @param {Array} nodes - Flow nodes
   * @returns {Object} - Processing result with response and next node
   */
  processNode(node, message, edges, nodes) {
    const handlers = {
      startNode: () => ({ response: this.processMessageNode(node, message), nextNode: null }),
      messageNode: () => ({ response: this.processMessageNode(node, message), nextNode: null }),
      defaultNode: () => ({ response: this.processMessageNode(node, message), nextNode: null }),
      conditionNode: () => this.processConditionNodeHelper(node, message, edges, nodes),
      responseNode: () => this.processResponseNodeWithNext(node, message, edges, nodes),
      actionNode: () => this.processActionNodeWithNext(node, edges, nodes),
    };

    const handler = handlers[node.type];
    if (handler) {
      return handler();
    }

    logger.info(`Unknown node type: ${node.type}`);
    return { response: null, nextNode: null };
  }

  /**
   * Process condition node
   * @private
   */
  processConditionNodeHelper(node, message, edges, nodes) {
    const conditionMet = this.evaluateCondition(node, message);
    const nextEdge = edges.find(
      (edge) => edge.source === node.id && edge.sourceHandle === (conditionMet ? 'true' : 'false'),
    );
    const nextNode = nextEdge
      ? nodes.find((targetNode) => targetNode.id === nextEdge.target)
      : null;
    return { response: null, nextNode };
  }

  /**
   * Process response node with next
   * @private
   */
  processResponseNodeWithNext(node, message, edges, nodes) {
    const response = this.processResponseNode(node, message);
    const nextEdge = edges.find((edge) => edge.source === node.id);
    const nextNode = nextEdge
      ? nodes.find((targetNode) => targetNode.id === nextEdge.target)
      : null;
    return { response, nextNode };
  }

  /**
   * Process action node with next
   * @private
   */
  processActionNodeWithNext(node, edges, nodes) {
    this.processActionNode(node);
    const nextEdge = edges.find((edge) => edge.source === node.id);
    const nextNode = nextEdge
      ? nodes.find((targetNode) => targetNode.id === nextEdge.target)
      : null;
    return { response: null, nextNode };
  }

  /**
   * Execute flow for a message
   * @param {string} message - User message
   * @returns {Object|null} - Flow response or null
   */
  executeFlow(message) {
    if (!this.validateFlowData()) {
      return null;
    }

    const { nodes, edges } = this.flowData;
    const startNode = this.findStartNode(nodes);
    if (!startNode) {
      return this.getDefaultResponse();
    }

    return this.traverseFlow(startNode, message, edges, nodes);
  }

  /**
   * Validate flow data
   * @private
   */
  validateFlowData() {
    if (!this.flowData || !this.flowData.nodes || this.flowData.nodes.length === 0) {
      logger.info('No flow data available');
      return false;
    }
    return true;
  }

  /**
   * Traverse flow from start node
   * @private
   */
  traverseFlow(startNode, message, edges, nodes) {
    let currentNode = startNode;
    let response = null;
    const maxIterations = 10;
    let iterations = 0;

    while (currentNode && iterations < maxIterations) {
      iterations += 1;
      const result = this.processNode(currentNode, message, edges, nodes);

      if (result.response) {
        ({ response } = result);
      }

      currentNode = result.nextNode;

      if (response && currentNode && currentNode.type === 'responseNode') {
        break;
      }
    }

    if (iterations >= maxIterations) {
      logger.warn('Flow execution reached maximum iterations');
    }

    return response || this.getDefaultResponse();
  }

  // Process message node
  /**
   *
   * @param node
   * @param message
   */
  processMessageNode(node, message) {
    const nodeData = node.data || {};

    // Check if node has a response message
    if (nodeData.message || nodeData.text || nodeData.response) {
      const responseText = nodeData.message || nodeData.text || nodeData.response;
      const processedResponse = this.replaceVariables(responseText, message);

      return {
        text: processedResponse,
        nodeId: node.id,
        nodeType: node.type,
      };
    }

    return null;
  }

  // Process condition node
  /**
   *
   * @param node
   * @param message
   * @param edges
   */
  processConditionNode(node, message, edges) {
    // Simple keyword-based condition matching
    const messageText = message.toLowerCase();

    // Find edges from this condition node
    const outgoingEdges = edges.filter((edge) => edge.source === node.id);

    for (const edge of outgoingEdges) {
      const edgeLabel = edge.label?.toLowerCase() || '';

      // Check if message contains keywords from edge label
      if (edgeLabel && messageText.includes(edgeLabel)) {
        logger.info(`Condition matched: ${edgeLabel}`);
        return edge.target;
      }
    }

    // Return first edge as default
    if (outgoingEdges.length > 0) {
      return outgoingEdges[0].target;
    }

    return null;
  }

  // Process response node
  /**
   * Get random response from array
   * @param {Array} responses - Array of responses
   * @returns {string} - Selected response
   */
  getRandomResponse(responses) {
    if (!Array.isArray(responses) || responses.length === 0) {
      return '';
    }
    const randomIndex = Math.floor(Math.random() * responses.length);
    // Safe array access
    return responses[Math.min(randomIndex, responses.length - 1)] || '';
  }

  /**
   *
   * @param node
   * @param message
   */
  processResponseNode(node, message) {
    const nodeData = node.data || {};
    const responses = nodeData.responses || [];

    // If multiple responses, pick one randomly
    if (responses.length > 0) {
      const responseText = this.getRandomResponse(responses);
      const processedResponse = this.replaceVariables(responseText, message);
      return {
        text: processedResponse,
        nodeId: node.id,
        nodeType: node.type,
      };
    }

    // Single response
    const singleResponse = nodeData.message || nodeData.text || nodeData.response;
    if (singleResponse) {
      const processedResponse = this.replaceVariables(singleResponse, message);
      return {
        text: processedResponse,
        nodeId: node.id,
        nodeType: node.type,
      };
    }

    return null;
  }

  /**
   * Save a variable to the flow context
   * @param {string} variableName - Variable name
   * @param {*} value - Variable value
   */
  saveVariable(variableName, value) {
    if (typeof variableName === 'string' && variableName.length > 0) {
      if (!this.flowState.variables) {
        this.flowState.variables = {};
      }
      this.flowState.variables = {
        ...this.flowState.variables,
        [variableName]: value,
      };
      logger.info(`Saved variable ${variableName} = ${value}`);
    }
  }

  /**
   * Get variable by name
   * @param {string} name - Variable name
   * @param {*} defaultValue - Default value
   * @returns {*} - Variable value or default
   */
  getVariable(name, defaultValue = null) {
    if (!this.flowState.variables || !name) {
      return defaultValue;
    }
    // Safe property access without object injection
    const { variables } = this.flowState;
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      // Return value using Object.getOwnPropertyDescriptor to avoid injection
      const descriptor = Object.getOwnPropertyDescriptor(variables, name);
      return descriptor ? descriptor.value : defaultValue;
    }
    return defaultValue;
  }

  /**
   * Get variable value
   * @param {string} variable - Variable name
   * @param {*} defaultValue - Default value
   * @returns {*} - Variable value or default
   */
  getVariableValue(variable, defaultValue = '') {
    if (
      this.flowState.variables &&
      Object.prototype.hasOwnProperty.call(this.flowState.variables, variable)
    ) {
      // Return the value from variables using safe access
      const { variables } = this.flowState;
      const descriptor = Object.getOwnPropertyDescriptor(variables, variable);
      return descriptor ? descriptor.value : defaultValue;
    }
    return defaultValue;
  }

  /**
   * Replace variables in text
   * @param {string} text - Text with variable placeholders
   * @returns {string} - Text with variables replaced
   */
  replaceVariables(text) {
    let processedText = text;

    // Replace common variables
    processedText = processedText.replaceAll(/{nombre}/gi, 'Usuario');
    processedText = processedText.replaceAll(/{fecha}/gi, new Date().toLocaleDateString());
    processedText = processedText.replaceAll(/{hora}/gi, new Date().toLocaleTimeString());
    // Replace variable placeholders
    processedText = processedText.replaceAll(/{{(\w+)}}/g, (match, variable) =>
      this.getVariableValue(variable),
    );

    return processedText;
  }

  // Get default response when no flow matches
  /**
   * Get default response when no flow matches
   */
  getDefaultResponse() {
    const defaultResponses = [
      'Hola! ¿En qué puedo ayudarte hoy?',
      'Gracias por tu mensaje. Un agente te atenderá pronto.',
      'Recibimos tu consulta. ¿Podrías proporcionar más detalles?',
      'Estoy aquí para ayudarte. ¿Cuál es tu consulta?',
    ];

    const randomIndex = Math.floor(Math.random() * defaultResponses.length);
    // Safe array access
    const selectedResponse = defaultResponses[Math.min(randomIndex, defaultResponses.length - 1)];
    return {
      text: selectedResponse,
      nodeId: 'default',
      nodeType: 'default',
    };
  }
}

// Singleton instance
let instance = null;

export const getInstance = () => {
  if (!instance) {
    instance = new FlowExecutor();
  }
  return instance;
};

export default FlowExecutor;
