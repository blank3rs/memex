export interface MemexProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  bio: string;
  tags: string[];
}

export interface MemexEntry {
  id: string;
  timestamp: string;
  type: "event" | "thought" | "fact" | "update";
  content: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

export interface MemexState {
  profile: MemexProfile;
  entries: MemexEntry[];
  lastSync: string | null;
}

export interface MemexConfig {
  dataDir: string;
  profileName: string;
  watchDir?: string;
  autoSave: boolean;
}
