/**
 * QIAN + WEN ANSI Shadow art (30 + 28 = 59 chars wide, 6 rows).
 * Generated with figlet v1.11.0, ANSI Shadow font.
 */
const qianLines = [
  ' ██████╗ ██╗ █████╗ ███╗   ██╗',
  '██╔═══██╗██║██╔══██╗████╗  ██║',
  '██║   ██║██║███████║██╔██╗ ██║',
  '██║▄▄ ██║██║██╔══██║██║╚██╗██║',
  '╚██████╔╝██║██║  ██║██║ ╚████║',
  ' ╚══▀▀═╝ ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝',
];

const wenLines = [
  '██╗    ██╗███████╗███╗   ██╗',
  '██║    ██║██╔════╝████╗  ██║',
  '██║ █╗ ██║█████╗  ██╔██╗ ██║',
  '██║███╗██║██╔══╝  ██║╚██╗██║',
  '╚███╔███╔╝███████╗██║ ╚████║',
  ' ╚══╝╚══╝ ╚══════╝╚═╝  ╚═══╝',
];

/** Site configuration for QianWen CLI. */
export const site = {
  key: 'qianwen',
  cliName: 'qianwen',
  cliDisplayName: 'QianWen CLI',
  keychainService: 'qianwen-cli',
  keychainAccount: 'cli_credentials',
  envPrefix: 'QIANWEN',
  configDirName: '.qianwen',
  localConfigFile: '.qianwen.json',
  apiEndpoint: 'https://cli.qianwenai.com',
  authEndpoint: 'https://t.qianwenai.com',
  dashscopeEndpoint: 'https://dashscope.aliyuncs.com',
  dashscopeEndpointName: 'dashscope',
  tokenPlanEndpoint: 'https://token-plan.cn-beijing.maas.aliyuncs.com',
  websiteUrl: 'www.qianwenai.com',
  docsBaseUrl: 'https://platform.qianwenai.com/docs',
  userAgentPrefix: 'qianwen-cli',
  sourceChannel: 'qianwenai-cli',
  replPrompt: 'qianwen ▸ ',
  apiKeyConsoleUrl: 'https://platform.qianwenai.com/home/api-keys',
  apiKeyEnvAliases: [],
  asciiArt: {
    leftLines: qianLines,
    rightLines: wenLines,
    leftWidth: 30,
    rightWidth: 28,
    combinedWidth: 59,
  },
  doctorTitle: 'QianWen CLI Doctor',
  npmPackage: '@qianwenai/qianwen-cli',
  features: {
    enableRepl: true,
    enableUsageBreakdown: true,
    enableFreeTier: true,
    enableModelSearch: true,
    enableTokenPlan: true,
    customHeaders: {},
    cdnBaseUrl: 'https://alioth.alicdn.com/model-mapping',
    tokenPlanCommodityCodes: {
      teams: 'sfm_tokenplanteams_dp_cn',
      personal: 'sfm_tokenplanpersonal_dp_cn',
      addon: 'sfm_tokenplanteamsaddon_dp_cn',
    },
    currency: 'CNY',
    workorder: {
      siteTag: 'qianwenai',
      productCodes: ['bailian'],
    },
  },
  defaults: {
    language: 'zh-CN',
  },
  uiTheme: {
    brand: '#3047F5',
    sectionTitle: '#3047F5',
    info: '#4F6DFF',
    data: '#5D7CFF',
    accent: '#F59E0B',
    success: '#22C55E',
    warning: '#F59E0B',
    error: '#EF4444',
    border: '#3047F5',
    muted: '#6B7280',
    tableHeader: {
      bg: '#3047F5',
      fg: '#FFFFFF',
    },
    logo: {
      border: '#3047F5',
      gradientStart: '#6F86FF',
      gradientEnd: '#263BDE',
      link: '#38BDF8',
    },
    progressGradient: {
      from: '#263BDE',
      to: '#B8C7FF',
    },
  },
};

declare const __VERSION__: string;

/** Brand-prefixed User-Agent for outbound requests, e.g. `qianwen-cli/<version>`. */
export function sourceUserAgent(): string {
  const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';
  return `${site.userAgentPrefix}/${version}`;
}

/** Guidance shown when a Token Plan key targets a model the plan does not support. */
export function tokenPlanModelUnsupportedMessage(): string {
  const personal = `${site.docsBaseUrl}/token-plan/personal/token-plan-personal-overview`;
  const team = `${site.docsBaseUrl}/token-plan/team/token-plan-team-overview`;
  return [
    '模型调用失败，可能原因：',
    '1. 模型 ID 拼写有误',
    '2. 该模型不在 Token Plan 支持范围内',
    '',
    '查看 Token Plan 支持的模型清单：',
    `  个人版：${personal}`,
    `  团队版：${team}`,
  ].join('\n');
}

/** Guidance shown when a Token Plan key is used to upload a local file. */
export function tokenPlanLocalUploadMessage(): string {
  return [
    'Token Plan 密钥（sk-sp-）只支持以 URL 形式传入媒体，无法上传本地文件。',
    '请将图片 / 视频 / 音频改为公网 URL（http/https 或 oss://），或改用按量付费密钥（sk- / sk-ws-）。',
  ].join('\n');
}
