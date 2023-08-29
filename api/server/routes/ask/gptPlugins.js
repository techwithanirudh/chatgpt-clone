const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { Logtail } = require('@logtail/node');
const { getResponseSender } = require('../endpoints/schemas');
const { validateTools } = require('../../../app');
const { addTitle } = require('../endpoints/openAI');
const { initializeClient } = require('../endpoints/gptPlugins');
const { saveMessage, getConvoTitle, getConvo } = require('../../../models');
const { sendMessage, createOnProgress } = require('../../utils');
const {
  handleAbort,
  createAbortController,
  handleAbortError,
  setHeaders,
  requireJwtAuth,
  validateEndpoint,
  buildEndpointOption,
} = require('../../middleware');

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 350,
  handler: function (req) {
    req.socket.end();
  },
});
var logtail;
try {
  logtail = new Logtail(process.env.LOGTAIL_TOKEN);
} catch {
  logtail = {
    log: () => {},
    info: () => {},
    error: () => {},
    flush: () => {},
  };
}

router.post('/abort', requireJwtAuth, handleAbort());

function verifiedRateLimiter(req, res, next) {
  const isPremium = req.user.emailVerified;

  if (isPremium) {
    return next();
  } else {
    limiter(req, res, next);
  }
}

router.post(
  '/',
  requireJwtAuth,
  verifiedRateLimiter,
  validateEndpoint,
  buildEndpointOption,
  setHeaders,
  async (req, res) => {
    let {
      text,
      endpointOption,
      conversationId,
      parentMessageId = null,
      overrideParentMessageId = null,
    } = req.body;
    const ip = req.headers['x-forwarded-for'];

    console.log(req.user.name + ': ' + text);
    logtail.log(req.user.name + ': ' + text, ip);

    let metadata;
    let userMessage;
    let userMessageId;
    let responseMessageId;
    let lastSavedTimestamp = 0;
    let saveDelay = 100;
    const newConvo = !conversationId;
    const user = req.user.id;

    const plugins = [];

    const addMetadata = (data) => (metadata = data);
    const getIds = (data) => {
      userMessage = data.userMessage;
      userMessageId = userMessage.messageId;
      responseMessageId = data.responseMessageId;
      if (!conversationId) {
        conversationId = data.conversationId;
      }
    };

    let streaming = null;
    let timer = null;

    const {
      onProgress: progressCallback,
      sendIntermediateMessage,
      getPartialText,
    } = createOnProgress({
      onProgress: ({ text: partialText }) => {
        const currentTimestamp = Date.now();

        if (timer) {
          clearTimeout(timer);
        }

        if (currentTimestamp - lastSavedTimestamp > saveDelay) {
          lastSavedTimestamp = currentTimestamp;
          saveMessage({
            messageId: responseMessageId,
            sender: getResponseSender(endpointOption),
            conversationId,
            parentMessageId: overrideParentMessageId || userMessageId,
            text: partialText,
            model: endpointOption.modelOptions.model,
            unfinished: true,
            cancelled: false,
            error: false,
            plugins,
          });
        }

        if (saveDelay < 500) {
          saveDelay = 500;
        }

        streaming = new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve();
          }, 250);
        });
      },
    });

    const pluginMap = new Map();
    const onAgentAction = async (action, runId) => {
      pluginMap.set(runId, action.tool);
      sendIntermediateMessage(res, { plugins });
    };

    const onToolStart = async (tool, input, runId, parentRunId) => {
      const pluginName = pluginMap.get(parentRunId);
      const latestPlugin = {
        runId,
        loading: true,
        inputs: [input],
        latest: pluginName,
        outputs: null,
      };

      if (streaming) {
        await streaming;
      }
      const extraTokens = ':::plugin:::\n';
      plugins.push(latestPlugin);
      sendIntermediateMessage(res, { plugins }, extraTokens);
    };

    const onToolEnd = async (output, runId) => {
      if (streaming) {
        await streaming;
      }

      const pluginIndex = plugins.findIndex((plugin) => plugin.runId === runId);

      if (pluginIndex !== -1) {
        plugins[pluginIndex].loading = false;
        plugins[pluginIndex].outputs = output;
      }
    };

    const onChainEnd = () => {
      saveMessage(userMessage);
      sendIntermediateMessage(res, { plugins });
    };

    const getAbortData = () => ({
      sender: getResponseSender(endpointOption),
      conversationId,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId,
      text: getPartialText(),
      plugins: plugins.map((p) => ({ ...p, loading: false })),
      userMessage,
    });
    const { abortController, onStart } = createAbortController(
      res,
      req,
      endpointOption,
      getAbortData,
    );

    try {
      endpointOption.tools = await validateTools(user, endpointOption.tools);
      const { client, azure, openAIApiKey } = initializeClient(req, endpointOption);

      let response = await client.sendMessage(text, {
        user,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        getIds,
        onAgentAction,
        onChainEnd,
        onToolStart,
        onToolEnd,
        onStart,
        addMetadata,
        getPartialText,
        ...endpointOption,
        onProgress: progressCallback.call(null, {
          res,
          text,
          parentMessageId: overrideParentMessageId || userMessageId,
          plugins,
        }),
        abortController,
      });

      if (overrideParentMessageId) {
        response.parentMessageId = overrideParentMessageId;
      }

      if (metadata) {
        response = { ...response, ...metadata };
      }

      // console.log('CLIENT RESPONSE');
      // console.dir(response, { depth: null });
      console.log(`AI responds to ${req.user.name}: `, response.text);
      logtail.log(`AI responds to ${req.user.name}: ` + response.text, ip);
      logtail.flush();
      response.plugins = plugins.map((p) => ({ ...p, loading: false }));
      await saveMessage(response);

      sendMessage(res, {
        title: await getConvoTitle(req.user.id, conversationId),
        final: true,
        conversation: await getConvo(req.user.id, conversationId),
        requestMessage: userMessage,
        responseMessage: response,
      });
      res.end();
      addTitle(req, {
        text,
        newConvo,
        response,
        openAIApiKey,
        parentMessageId,
        azure: !!azure,
      });
    } catch (error) {
      const partialText = getPartialText();

      console.error(error);
      logtail.error(error);
      logtail.flush();

      handleAbortError(res, req, error, {
        partialText,
        conversationId,
        sender: getResponseSender(endpointOption),
        messageId: responseMessageId,
        parentMessageId: userMessageId,
      });
    }
  },
);

module.exports = router;
