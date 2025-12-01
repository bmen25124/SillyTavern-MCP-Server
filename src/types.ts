import { Request as ExpressRequest } from 'express';

export interface Request extends ExpressRequest {
  user: {
    directories: UserDirectoryList;
    [key: string]: any;
  };
}

export interface UserDirectoryList {
  root: string;
  [key: string]: string;
}
