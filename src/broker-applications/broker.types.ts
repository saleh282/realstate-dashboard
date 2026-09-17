export enum BrokerApplicationStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export type BrokerReviewDecision = 'APPROVED' | 'REJECTED';
