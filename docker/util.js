const NodeCache = require("node-cache");
const cache = new NodeCache();

const parsePath = (path) => {
  if (!path) {
    return [];
  }

  return path.split('/').filter((node) => {
    return !!node;
  })
}

const formatPath = (parsedPath) => {
  if (!Array.isArray(parsedPath) || parsedPath.length === 0) {
    return '/';
  }
  let formatted = '';
  for (const label of parsedPath) {
    formatted += '/' + String(label);
  }
  return (formatted.startsWith('/') ? '' : '/') + formatted;
}
const validateTransaction = (tx_body) => {
  const { task_id, temp_image_url } = tx_body.operation.value.params;
  return task_id !== '' && temp_image_url !== '';
}

const errorHandler = (taskId, msg) => {
  console.error(msg, e);
  cache.set(taskId, 'error', 300);
}

module.exports = {
  parsePath,
  formatPath,
  validateTransaction,
  errorHandler
}