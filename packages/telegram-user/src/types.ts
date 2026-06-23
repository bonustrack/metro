export interface UserAccount {
  id: string;
  session: string;
  apiId?: number;
  apiHash?: string;
  owner?: string;
}
