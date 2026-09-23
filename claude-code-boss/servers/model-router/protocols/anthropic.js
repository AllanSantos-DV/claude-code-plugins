'use strict';

function toUpstreamRequest(body) {
  return body;
}

function fromUpstreamJson(body) {
  return body;
}

module.exports = {
  wireProtocol: 'anthropic',
  toUpstreamRequest,
  fromUpstreamJson,
};
