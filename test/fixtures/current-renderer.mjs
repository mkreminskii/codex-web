export const currentRendererFixture = `
function LocalFolder(e){let t=(0,Compiler.c)(56),{sources:n,setSources:r}=e;subscribe(\`workspace-root-option-picked\`,()=>{});let b=()=>bridge.dispatchMessage(\`electron-pick-workspace-root-option\`,{allowMultiple:!0});return(0,jsx.jsx)(Message,{id:\`projectSetup.createLocalProject.sourceFoldersLabel\`,defaultMessage:\`Source folders\`})}
function DirectoryBrowser(e){let t=(0,RemoteCompiler.c)(39);query(\`remote-workspace-directory-entries\`,{hostId:e.hostId});return e.setSelectedPath}
function InitDirectoryBrowser(){RemoteCompiler=loadCompiler()}
function statsigOptions(e){let t={...baseOptions,enableLiveValuesAutoRefresh:!0,...e===!0?{}:{disableStorage:!0,loggingEnabled:\`disabled\`}};return t}
async function statsigTransport(e,t,n=!0){if(!n&&e===\`https://ab.chatgpt.com/v1/sdk_exception\`)return new Response(null,{status:204});return fetch(e,t)}
function analyticsProvider(r){return{submitCodexAnalyticsEvent:r===\`chatgpt\`?sendAnalytics:null}}
function activity(e,t){return{projectGroup:e(GroupSelector,t)}}
function Details(e){let t=(0,Compiler.c)(19),{chatGptConversationId:n,chatGptProjectId:r,itemKind:i,localThreadKey:a,projectGroup:o,sidebarMode:s}=e,c=read(Mode),l=hook(Flag,\`2031251742\`);return(0,jsx.jsx)(Message,{id:\`sidebarElectron.priorityThreads.details.codex\`,defaultMessage:\`Codex\`,description:\`Source label for a standalone Codex task in the Priority filter\`})}
function Row(e){let r=items.get(e),M=false;if(r?.source===\`codex\`)return(0,jsx.jsx)(ThreadRow,{archiveGroup:group,threadKey:r.threadKey,secondaryContent:M?(0,jsx.jsx)(Summary,{conversation:r}):void 0,wrapSecondaryContent:M,variant:variant})}
`;
