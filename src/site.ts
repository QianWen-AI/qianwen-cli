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
  websiteUrl: 'www.qianwenai.com',
  docsBaseUrl: 'https://platform.qianwenai.com/docs',
  userAgentPrefix: 'qianwen-cli',
  replPrompt: 'qianwen ▸ ',
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
