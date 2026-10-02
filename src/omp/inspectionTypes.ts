export interface InspectorAgent {
  id: string;
  name: string;
  kind: "worker" | "advisor";
  parentId?: string;
  status: string;
  model?: string;
  sessionFile?: string;
  canSteer: boolean;
  canCancel: boolean;
}

export interface InspectorNotice {
  source: string;
  message: string;
  timestamp: number;
}

export interface InspectionSnapshot {
  agents: InspectorAgent[];
  notices: InspectorNotice[];
  selectedId?: string;
  transcript?: { agentId: string; messages: unknown[]; readOnly: boolean };
  error?: string;
}

export type InspectorSnapshot = InspectionSnapshot;
