export type ChatType = 'private' | 'group' | 'channel';
export type CallType = 'voice' | 'video' | 'screen';
export interface UserProfile { id: string; username: string; displayName: string; avatarUrl?: string; bio: string; status: 'online' | 'offline'; }
export interface Chat { id: string; type: ChatType; title?: string; description: string; }
export interface Message { id: string; chat_id: string; sender_id: string; body: string; created_at: string; edited_at?: string; }
