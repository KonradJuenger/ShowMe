import { EFFECT_API_VERSION } from "./effects";

export const AGENT_CONTRACT_VERSION = 3;
export const AGENT_RUNTIME_CAPACITY = 8;
export const agentProtocolCapabilities = {
  effectApiVersion: EFFECT_API_VERSION,
  features: {
    shaderEffects: true,
    cssEffects: true,
    textJsEffects: true,
    deckCss: true,
    motion: true,
    presence: true,
    measureText: true,
    preview: true,
    timelineSampling: true,
    multiPageBatches: true,
    delivery: true,
    templateAuthoring: true,
    sharedEffectResources: "page-or-template",
    slideRecipes: true,
    workspace: true,
    expandedBudget: true,
    reducedMotionLimit: false,
  },
  cssRules: [":scope", "@keyframes", "@supports"],
  runtime: { capacity: AGENT_RUNTIME_CAPACITY, lazyInitialization: true },
};
