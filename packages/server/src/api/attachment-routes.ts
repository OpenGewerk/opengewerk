import type { Permission } from '@opengewerk/domain'
import type { AttachmentRights, AttachmentRoutes } from '@opengewerk/platform-server'
import { sql } from 'drizzle-orm'

import type { AttachmentHomeColumns } from '../database/schema/attachments.js'
import { attachments, attachmentVersions } from '../database/schema/index.js'

/** The right of the routes of the files, which is the one of the records. */
export const attachmentRights: AttachmentRights<Permission> = {
  read: 'attachment.read',
}

/**
 * The files of a business's records, handed out by version (#77), on the
 * routes of the foundation (opengewerk-haustechnik#97).
 *
 * Asked by the id of a version and never by hash, in the business of whoever
 * asks, and only while the file has not been removed from the records. What a
 * file hangs on, a customer, a site, an installation, an appliance or a job, is said in the
 * schema; whoever may read the records may read every file in them, so
 * nothing is looked at here before one is handed out.
 *
 * A file in the bin is handed out where a signed protocol of what it hangs on
 * names it and it went to the bin after the signature (opengewerk#937): the
 * page of the protocol shows it then (`protocol-photos.ts`), and so does the
 * protocol in the application. What the protocol is about is its
 * installation, else its appliance, else the job of an acceptance, as there.
 */
export const attachmentRoutes: AttachmentRoutes<AttachmentHomeColumns> = {
  tables: { attachments, attachmentVersions },
  keptInBin: async ({ tx, attachment }) => {
    const named = `"${String(attachment['id'])}"`
    const { rows } = await tx.execute(sql`
      select 1
        from form_records f
       where f.status = 'signed'
         and f.change_sequence < ${attachment['changeSequence']}
         and case
               when f.installation_id is not null then f.installation_id = ${attachment['installationId']}
               when f.appliance_id is not null then f.appliance_id = ${attachment['applianceId']}
               else f.job_id = ${attachment['jobId']}
             end
         and strpos(lower(f."values"), ${named}) > 0
       limit 1`)

    return rows.length > 0
  },
}
