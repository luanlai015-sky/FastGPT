import { NodeInputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import {
  DispatchNodeResponseKeyEnum,
  SseResponseEventEnum
} from '@fastgpt/global/core/workflow/runtime/constants';
import { NodeOutputKeyEnum } from '@fastgpt/global/core/workflow/constants';
import type {
  ChatDispatchProps,
  DispatchNodeResultType,
  ModuleDispatchProps,
  SystemVariablesType
} from '@fastgpt/global/core/workflow/runtime/type';
import type { RuntimeNodeItemType } from '@fastgpt/global/core/workflow/runtime/type.d';
import type {
  AIChatItemValueItemType,
  ChatHistoryItemResType,
  NodeOutputItemType,
  ToolRunResponseItemType
} from '@fastgpt/global/core/chat/type.d';
import {
  FlowNodeInputTypeEnum,
  FlowNodeTypeEnum
} from '@fastgpt/global/core/workflow/node/constant';
import { getNanoid, replaceVariable } from '@fastgpt/global/common/string/tools';
import { getSystemTime } from '@fastgpt/global/common/time/timezone';
import { replaceEditorVariable } from '@fastgpt/global/core/workflow/utils';

import { dispatchWorkflowStart } from './init/workflowStart';
import { dispatchChatCompletion } from './chat/oneapi';
import { dispatchDatasetSearch } from './dataset/search';
import { dispatchDatasetConcat } from './dataset/concat';
import { dispatchAnswer } from './tools/answer';
import { dispatchClassifyQuestion } from './agent/classifyQuestion';
import { dispatchContentExtract } from './agent/extract';
import { dispatchHttp468Request } from './tools/http468';
import { dispatchAppRequest } from './abandoned/runApp';
import { dispatchQueryExtension } from './tools/queryExternsion';
import { dispatchRunPlugin } from './plugin/run';
import { dispatchPluginInput } from './plugin/runInput';
import { dispatchPluginOutput } from './plugin/runOutput';
import { removeSystemVariable, valueTypeFormat } from './utils';
import {
  filterWorkflowEdges,
  checkNodeRunStatus
} from '@fastgpt/global/core/workflow/runtime/utils';
import { ChatNodeUsageType } from '@fastgpt/global/support/wallet/bill/type';
import { dispatchRunTools } from './agent/runTool/index';
import { ChatItemValueTypeEnum } from '@fastgpt/global/core/chat/constants';
import { DispatchFlowResponse } from './type';
import { dispatchStopToolCall } from './agent/runTool/stopTool';
import { dispatchLafRequest } from './tools/runLaf';
import { dispatchIfElse } from './tools/runIfElse';
import { RuntimeEdgeItemType } from '@fastgpt/global/core/workflow/type/edge';
import { getReferenceVariableValue } from '@fastgpt/global/core/workflow/runtime/utils';
import { dispatchSystemConfig } from './init/systemConfig';
import { dispatchUpdateVariable } from './tools/runUpdateVar';
import { addLog } from '../../../common/system/log';
import { surrenderProcess } from '../../../common/system/tools';
import { dispatchRunCode } from './code/run';
import { dispatchTextEditor } from './tools/textEditor';
import { dispatchCustomFeedback } from './tools/customFeedback';
import { dispatchReadFiles } from './tools/readFiles';
import { dispatchUserSelect } from './interactive/userSelect';
import {
  InteractiveNodeResponseItemType,
  UserSelectInteractive
} from '@fastgpt/global/core/workflow/template/system/userSelect/type';
import { dispatchRunAppNode } from './plugin/runApp';

const callbackMap: Record<FlowNodeTypeEnum, Function> = {
  [FlowNodeTypeEnum.workflowStart]: dispatchWorkflowStart,
  [FlowNodeTypeEnum.answerNode]: dispatchAnswer,
  [FlowNodeTypeEnum.chatNode]: dispatchChatCompletion,
  [FlowNodeTypeEnum.datasetSearchNode]: dispatchDatasetSearch,
  [FlowNodeTypeEnum.datasetConcatNode]: dispatchDatasetConcat,
  [FlowNodeTypeEnum.classifyQuestion]: dispatchClassifyQuestion,
  [FlowNodeTypeEnum.contentExtract]: dispatchContentExtract,
  [FlowNodeTypeEnum.httpRequest468]: dispatchHttp468Request,
  [FlowNodeTypeEnum.appModule]: dispatchRunAppNode,
  [FlowNodeTypeEnum.pluginModule]: dispatchRunPlugin,
  [FlowNodeTypeEnum.pluginInput]: dispatchPluginInput,
  [FlowNodeTypeEnum.pluginOutput]: dispatchPluginOutput,
  [FlowNodeTypeEnum.queryExtension]: dispatchQueryExtension,
  [FlowNodeTypeEnum.tools]: dispatchRunTools,
  [FlowNodeTypeEnum.stopTool]: dispatchStopToolCall,
  [FlowNodeTypeEnum.lafModule]: dispatchLafRequest,
  [FlowNodeTypeEnum.ifElseNode]: dispatchIfElse,
  [FlowNodeTypeEnum.variableUpdate]: dispatchUpdateVariable,
  [FlowNodeTypeEnum.code]: dispatchRunCode,
  [FlowNodeTypeEnum.textEditor]: dispatchTextEditor,
  [FlowNodeTypeEnum.customFeedback]: dispatchCustomFeedback,
  [FlowNodeTypeEnum.readFiles]: dispatchReadFiles,
  [FlowNodeTypeEnum.userSelect]: dispatchUserSelect,

  // none
  [FlowNodeTypeEnum.systemConfig]: dispatchSystemConfig,
  [FlowNodeTypeEnum.pluginConfig]: () => Promise.resolve(),
  [FlowNodeTypeEnum.emptyNode]: () => Promise.resolve(),
  [FlowNodeTypeEnum.globalVariable]: () => Promise.resolve(),

  [FlowNodeTypeEnum.runApp]: dispatchAppRequest // abandoned
};

type Props = ChatDispatchProps & {
  runtimeNodes: RuntimeNodeItemType[];
  runtimeEdges: RuntimeEdgeItemType[];
};

/* running */
export async function dispatchWorkFlow(data: Props): Promise<DispatchFlowResponse> {
  let {
    res,
    runtimeNodes = [],
    runtimeEdges = [],
    histories = [],
    variables = {},
    user,
    stream = false,
    ...props
  } = data;

  // set sse response headers
  if (stream && res) {
    res.setHeader('Content-Type', 'text/event-stream;charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
  }

  variables = {
    ...getSystemVariable(data),
    ...variables
  };

  let chatResponses: ChatHistoryItemResType[] = []; // response request and save to database
  let chatAssistantResponse: AIChatItemValueItemType[] = []; // The value will be returned to the user
  let chatNodeUsages: ChatNodeUsageType[] = [];
  let toolRunResponse: ToolRunResponseItemType;
  let debugNextStepRunNodes: RuntimeNodeItemType[] = [];
  // 记录交互节点，交互节点需要在工作流完全结束后再进行计算
  let workflowInteractiveResponse:
    | {
        entryNodeIds: string[];
        interactiveResponse: UserSelectInteractive;
      }
    | undefined;

  /* Store special response field  */
  function pushStore(
    { inputs = [] }: RuntimeNodeItemType,
    {
      answerText = '',
      responseData,
      nodeDispatchUsages,
      toolResponses,
      assistantResponses,
      rewriteHistories
    }: Omit<
      DispatchNodeResultType<{
        [NodeOutputKeyEnum.answerText]?: string;
        [DispatchNodeResponseKeyEnum.nodeResponse]?: ChatHistoryItemResType;
      }>,
      'nodeResponse'
    >
  ) {
    if (responseData) {
      chatResponses.push(responseData);
    }
    if (nodeDispatchUsages) {
      chatNodeUsages = chatNodeUsages.concat(nodeDispatchUsages);
    }
    if (toolResponses !== undefined) {
      if (Array.isArray(toolResponses) && toolResponses.length === 0) return;
      if (typeof toolResponses === 'object' && Object.keys(toolResponses).length === 0) {
        return;
      }
      toolRunResponse = toolResponses;
    }
    if (assistantResponses) {
      chatAssistantResponse = chatAssistantResponse.concat(assistantResponses);
    } else if (answerText) {
      // save assistant text response
      const isResponseAnswerText =
        inputs.find((item) => item.key === NodeInputKeyEnum.aiChatIsResponseText)?.value ?? true;
      if (isResponseAnswerText) {
        chatAssistantResponse.push({
          type: ChatItemValueTypeEnum.text,
          text: {
            content: answerText
          }
        });
      }
    }

    if (rewriteHistories) {
      histories = rewriteHistories;
    }
  }
  /* Pass the output of the node, to get next nodes and update edge status */
  function nodeOutput(
    node: RuntimeNodeItemType,
    result: Record<string, any> = {}
  ): {
    nextStepActiveNodes: RuntimeNodeItemType[];
    nextStepSkipNodes: RuntimeNodeItemType[];
  } {
    pushStore(node, result);

    // Assign the output value to the next node
    node.outputs.forEach((outputItem) => {
      if (result[outputItem.key] === undefined) return;
      /* update output value */
      outputItem.value = result[outputItem.key];
    });

    // Get next source edges and update status
    const skipHandleId = (result[DispatchNodeResponseKeyEnum.skipHandleId] || []) as string[];
    const targetEdges = filterWorkflowEdges(runtimeEdges).filter(
      (item) => item.source === node.nodeId
    );

    // update edge status
    targetEdges.forEach((edge) => {
      if (skipHandleId.includes(edge.sourceHandle)) {
        edge.status = 'skipped';
      } else {
        edge.status = 'active';
      }
    });

    const nextStepActiveNodes: RuntimeNodeItemType[] = [];
    const nextStepSkipNodes: RuntimeNodeItemType[] = [];
    runtimeNodes.forEach((node) => {
      if (targetEdges.some((item) => item.target === node.nodeId && item.status === 'active')) {
        nextStepActiveNodes.push(node);
      }
      if (targetEdges.some((item) => item.target === node.nodeId && item.status === 'skipped')) {
        nextStepSkipNodes.push(node);
      }
    });

    if (props.mode === 'debug') {
      debugNextStepRunNodes = debugNextStepRunNodes.concat([
        ...nextStepActiveNodes,
        ...nextStepSkipNodes
      ]);
      return {
        nextStepActiveNodes: [],
        nextStepSkipNodes: []
      };
    }

    return {
      nextStepActiveNodes,
      nextStepSkipNodes
    };
  }

  /* Have interactive result, computed edges and node outputs */
  function handleInteractiveResult({
    entryNodeIds,
    interactiveResponse
  }: {
    entryNodeIds: string[];
    interactiveResponse: UserSelectInteractive;
  }): AIChatItemValueItemType {
    // Get node outputs
    const nodeOutputs: NodeOutputItemType[] = [];
    runtimeNodes.forEach((node) => {
      node.outputs.forEach((output) => {
        if (output.value) {
          nodeOutputs.push({
            nodeId: node.nodeId,
            key: output.key as NodeOutputKeyEnum,
            value: output.value
          });
        }
      });
    });

    const interactiveResult: InteractiveNodeResponseItemType = {
      ...interactiveResponse,
      entryNodeIds,
      memoryEdges: runtimeEdges.map((edge) => ({
        ...edge,
        status: entryNodeIds.includes(edge.target)
          ? 'active'
          : entryNodeIds.includes(edge.source)
            ? 'waiting'
            : edge.status
      })),
      nodeOutputs
    };

    props.workflowStreamResponse?.({
      event: SseResponseEventEnum.interactive,
      data: { interactive: interactiveResult }
    });

    return {
      type: ChatItemValueTypeEnum.interactive,
      interactive: interactiveResult
    };
  }

  // 每个节点确定 运行/跳过 前，初始化边的状态
  function nodeRunBeforeHook(node: RuntimeNodeItemType) {
    runtimeEdges.forEach((item) => {
      if (item.target === node.nodeId) {
        item.status = 'waiting';
      }
    });
  }
  /* Check node run/skip or wait */
  async function checkNodeCanRun(
    node: RuntimeNodeItemType,
    skippedNodeIdList = new Set<string>()
  ): Promise<RuntimeNodeItemType[]> {
    if (res?.closed || props.maxRunTimes <= 0) return [];
    // Thread avoidance
    await surrenderProcess();

    addLog.debug(`Run node`, { maxRunTimes: props.maxRunTimes, appId: props.runningAppInfo.id });

    // Get node run status by edges
    const status = checkNodeRunStatus({
      node,
      runtimeEdges
    });
    const nodeRunResult = await (() => {
      if (status === 'run') {
        nodeRunBeforeHook(node);
        props.maxRunTimes--;
        addLog.debug(`[dispatchWorkFlow] nodeRunWithActive: ${node.name}`);
        return nodeRunWithActive(node);
      }
      if (status === 'skip' && !skippedNodeIdList.has(node.nodeId)) {
        nodeRunBeforeHook(node);
        props.maxRunTimes -= 0.1;
        skippedNodeIdList.add(node.nodeId);
        addLog.debug(`[dispatchWorkFlow] nodeRunWithSkip: ${node.name}`);
        return nodeRunWithSkip(node);
      }
    })();

    if (!nodeRunResult) return [];

    // In the current version, only one interactive node is allowed at the same time
    const interactiveResponse = nodeRunResult.result?.[DispatchNodeResponseKeyEnum.interactive];
    if (interactiveResponse) {
      workflowInteractiveResponse = {
        entryNodeIds: [nodeRunResult.node.nodeId],
        interactiveResponse
      };
      return [];
    }

    // Update the node output at the end of the run and get the next nodes
    let { nextStepActiveNodes, nextStepSkipNodes } = nodeOutput(
      nodeRunResult.node,
      nodeRunResult.result
    );
    // Remove repeat nodes(Make sure that the node is only executed once)
    nextStepActiveNodes = nextStepActiveNodes.filter(
      (node, index, self) => self.findIndex((t) => t.nodeId === node.nodeId) === index
    );
    nextStepSkipNodes = nextStepSkipNodes.filter(
      (node, index, self) => self.findIndex((t) => t.nodeId === node.nodeId) === index
    );

    // Run next nodes（先运行 run 的，再运行 skip 的）
    const nextStepActiveNodesResults = (
      await Promise.all(nextStepActiveNodes.map((node) => checkNodeCanRun(node)))
    ).flat();

    // 如果已经 active 运行过，不再执行 skip（active 中有闭环）
    nextStepSkipNodes = nextStepSkipNodes.filter(
      (node) => !nextStepActiveNodesResults.some((item) => item.nodeId === node.nodeId)
    );

    const nextStepSkipNodesResults = (
      await Promise.all(nextStepSkipNodes.map((node) => checkNodeCanRun(node, skippedNodeIdList)))
    ).flat();

    return [
      ...nextStepActiveNodes,
      ...nextStepSkipNodes,
      ...nextStepActiveNodesResults,
      ...nextStepSkipNodesResults
    ];
  }
  /* Inject data into module input */
  function getNodeRunParams(node: RuntimeNodeItemType) {
    if (node.flowNodeType === FlowNodeTypeEnum.pluginInput) {
      // Format plugin input to object
      return node.inputs.reduce<Record<string, any>>((acc, item) => {
        acc[item.key] = valueTypeFormat(item.value, item.valueType);
        return acc;
      }, {});
    }

    // Dynamic input need to store a key.
    const dynamicInput = node.inputs.find(
      (item) => item.renderTypeList[0] === FlowNodeInputTypeEnum.addInputParam
    );
    const params: Record<string, any> = dynamicInput
      ? {
          [dynamicInput.key]: {}
        }
      : {};

    node.inputs.forEach((input) => {
      if (input.key === dynamicInput?.key) return;

      // replace {{xx}} variables
      let value = replaceVariable(input.value, variables);

      // replace {{$xx.xx$}} variables
      value = replaceEditorVariable({
        text: value,
        nodes: runtimeNodes,
        variables,
        runningNode: node
      });

      // replace reference variables
      value = getReferenceVariableValue({
        value,
        nodes: runtimeNodes,
        variables
      });

      // Dynamic input is stored in the dynamic key
      if (input.canEdit && dynamicInput && params[dynamicInput.key]) {
        params[dynamicInput.key][input.key] = valueTypeFormat(value, input.valueType);
      }

      params[input.key] = valueTypeFormat(value, input.valueType);
    });

    return params;
  }
  async function nodeRunWithActive(node: RuntimeNodeItemType): Promise<{
    node: RuntimeNodeItemType;
    runStatus: 'run';
    result: Record<string, any>;
  }> {
    // push run status messages
    if (node.showStatus) {
      props.workflowStreamResponse?.({
        event: SseResponseEventEnum.flowNodeStatus,
        data: {
          status: 'running',
          name: node.name
        }
      });
    }
    const startTime = Date.now();

    // get node running params
    const params = getNodeRunParams(node);

    const dispatchData: ModuleDispatchProps<Record<string, any>> = {
      ...props,
      res,
      variables,
      histories,
      user,
      stream,
      node,
      runtimeNodes,
      runtimeEdges,
      params,
      mode: props.mode === 'debug' ? 'test' : props.mode
    };

    // run module
    const dispatchRes: Record<string, any> = await (async () => {
      if (callbackMap[node.flowNodeType]) {
        return callbackMap[node.flowNodeType](dispatchData);
      }
      return {};
    })();

    // format response data. Add modulename and module type
    const formatResponseData: ChatHistoryItemResType = (() => {
      if (!dispatchRes[DispatchNodeResponseKeyEnum.nodeResponse]) return undefined;
      return {
        id: getNanoid(),
        nodeId: node.nodeId,
        moduleName: node.name,
        moduleType: node.flowNodeType,
        runningTime: +((Date.now() - startTime) / 1000).toFixed(2),
        ...dispatchRes[DispatchNodeResponseKeyEnum.nodeResponse]
      };
    })();

    // Add output default value
    node.outputs.forEach((item) => {
      if (!item.required) return;
      if (dispatchRes[item.key] !== undefined) return;
      dispatchRes[item.key] = valueTypeFormat(item.defaultValue, item.valueType);
    });

    return {
      node,
      runStatus: 'run',
      result: {
        ...dispatchRes,
        [DispatchNodeResponseKeyEnum.nodeResponse]: formatResponseData
      }
    };
  }
  async function nodeRunWithSkip(node: RuntimeNodeItemType): Promise<{
    node: RuntimeNodeItemType;
    runStatus: 'skip';
    result: Record<string, any>;
  }> {
    // Set target edges status to skipped
    const targetEdges = runtimeEdges.filter((item) => item.source === node.nodeId);

    return {
      node,
      runStatus: 'skip',
      result: {
        [DispatchNodeResponseKeyEnum.skipHandleId]: targetEdges.map((item) => item.sourceHandle)
      }
    };
  }

  // start process width initInput
  const entryNodes = runtimeNodes.filter((item) => item.isEntry);

  // reset entry
  // runtimeNodes.forEach((item) => {
  //   item.isEntry = false;
  // });
  await Promise.all(entryNodes.map((node) => checkNodeCanRun(node)));

  // focus try to run pluginOutput
  const pluginOutputModule = runtimeNodes.find(
    (item) => item.flowNodeType === FlowNodeTypeEnum.pluginOutput
  );
  if (pluginOutputModule && props.mode !== 'debug') {
    await nodeRunWithActive(pluginOutputModule);
  }

  // Interactive node
  if (workflowInteractiveResponse) {
    const interactiveResult = handleInteractiveResult({
      entryNodeIds: workflowInteractiveResponse.entryNodeIds,
      interactiveResponse: workflowInteractiveResponse.interactiveResponse
    });
    chatAssistantResponse.push(interactiveResult);
  }

  return {
    flowResponses: chatResponses,
    flowUsages: chatNodeUsages,
    debugResponse: {
      finishedNodes: runtimeNodes,
      finishedEdges: runtimeEdges,
      nextStepRunNodes: debugNextStepRunNodes
    },
    [DispatchNodeResponseKeyEnum.assistantResponses]:
      mergeAssistantResponseAnswerText(chatAssistantResponse),
    [DispatchNodeResponseKeyEnum.toolResponses]: toolRunResponse,
    newVariables: removeSystemVariable(variables)
  };
}

/* get system variable */
export function getSystemVariable({
  user,
  runningAppInfo,
  chatId,
  responseChatItemId,
  histories = [],
  uid
}: Props): SystemVariablesType {
  return {
    userId: uid,
    appId: String(runningAppInfo.id),
    chatId,
    responseChatItemId,
    histories,
    cTime: getSystemTime(user.timezone)
  };
}

/* Merge consecutive text messages into one */
export const mergeAssistantResponseAnswerText = (response: AIChatItemValueItemType[]) => {
  const result: AIChatItemValueItemType[] = [];
  // 合并连续的text
  for (let i = 0; i < response.length; i++) {
    const item = response[i];
    if (item.type === ChatItemValueTypeEnum.text) {
      let text = item.text?.content || '';
      const lastItem = result[result.length - 1];
      if (lastItem && lastItem.type === ChatItemValueTypeEnum.text && lastItem.text?.content) {
        lastItem.text.content += text;
        continue;
      }
    }
    result.push(item);
  }

  return result;
};
