import { axiosClient } from "./axios-client";

export interface TableOperationCandidate {
  tableId: string;
  tableIds: string[];
  tableCodes: string[];
  displayName: string;
  status: "available" | "occupied" | "waiting_payment";
  sessionId?: string;
  groupKey: string;
}

export interface UnmergeOperationCandidate {
  kind: "session" | "table_group";
  childSessionId?: string;
  rootSessionId?: string;
  tableId?: string;
  tableIds: string[];
  displayName: string;
  mergedAt?: string;
}

export interface TableOperationOptions {
  moveSources: TableOperationCandidate[];
  moveDestinations: TableOperationCandidate[];
  mergeCandidates: TableOperationCandidate[];
  unmergeGroups: UnmergeOperationCandidate[];
}

export const sessionApi = {
  getTableOperationOptions: async (): Promise<TableOperationOptions> =>
    (await axiosClient.get<TableOperationOptions>("/sessions/table-operation-options")).data,
  moveTable: async (
    sessionId: string,
    newTableId: string,
  ): Promise<{ sessionId: string }> => {
    const response = await axiosClient.patch<{ sessionId: string }>(
      `/sessions/${sessionId}/move-table`,
      { newTableId },
    );
    return response.data;
  },
  mergeTables: async (
    sourceTableId: string,
    targetTableId: string,
  ): Promise<{
    case: "grouped" | "joined" | "merged";
    rootSessionId?: string;
  }> => {
    const response = await axiosClient.post<{
      case: "grouped" | "joined" | "merged";
      rootSessionId?: string;
    }>("/sessions/merge-tables", { sourceTableId, targetTableId });
    return response.data;
  },
  unmerge: async (
    childSessionId?: string,
    tableId?: string,
  ): Promise<
    | { case: "session"; childSessionId: string; status: "active" }
    | { case: "ungrouped"; tableIds: string[]; status: "available" }
  > =>
    (await axiosClient.post("/sessions/unmerge", { childSessionId, tableId }))
      .data,
};
