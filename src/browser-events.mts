export interface NavigationDetails {
  tabId: number;
  url: string;
  frameId: number;
  timeStamp: number;
}

export interface TabChange {
  url?: string;
}

export function isMainFrame(details: { frameId: number }): boolean {
  return details.frameId === 0
}

export function isUrlChange(change: TabChange): change is { url: string } {
  return change.url !== undefined
}
