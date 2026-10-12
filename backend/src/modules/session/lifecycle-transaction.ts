import { ConflictException } from '@nestjs/common';
import { ClientSession, Connection } from 'mongoose';

/** Retry an uncertain commit, but never reinterpret an operator's action on a
 * newer snapshot after a competing lifecycle operation has won. */
export function lifecycleTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  let attempted = false;
  return connection.transaction(
    async (session) => {
      if (attempted)
        throw new ConflictException(
          'Phiên hoặc bàn vừa thay đổi, vui lòng tải lại',
        );
      attempted = true;
      return work(session);
    },
    { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
  );
}
