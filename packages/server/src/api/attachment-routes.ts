import {
  chosenPhotos,
  type Permission,
  readFormValues,
  shownPhotoVersion,
} from '@opengewerk/domain'
import type { AttachmentRights, AttachmentRoutes } from '@opengewerk/platform-server'
import { desc, eq, sql } from 'drizzle-orm'

import type { AttachmentHomeColumns } from '../database/schema/attachments.js'
import { attachments, attachmentVersions } from '../database/schema/index.js'
import { tradeForms } from '../forms/registry.js'

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
 * A version of a file in the bin is handed out where a signed protocol of what
 * it hangs on names the file in a photo field, the file went to the bin after
 * the signature, and the version is the one that protocol shows (opengewerk#937): the
 * page of the protocol shows it then (`protocol-photos.ts`), and so does the
 * protocol in the application. What the protocol is about is its
 * installation, else its appliance, else the job of an acceptance, as there.
 */
export const attachmentRoutes: AttachmentRoutes<AttachmentHomeColumns> = {
  tables: { attachments, attachmentVersions },
  keptInBin: async ({ tx, attachment, version }) => {
    const id = String(attachment['id'])
    const { rows } = await tx.execute<{
      definition_key: string
      definition_version: number
      values: string
      change_sequence: string
    }>(sql`
      select f.definition_key, f.definition_version, f."values", f.change_sequence::text
        from form_records f
       where f.status = 'signed'
         and f.change_sequence < ${attachment['changeSequence']}
         and case
               when f.installation_id is not null then f.installation_id = ${attachment['installationId']}
               when f.appliance_id is not null then f.appliance_id = ${attachment['applianceId']}
               else f.job_id = ${attachment['jobId']}
             end
         and strpos(lower(f."values"), ${`"${id}"`}) > 0`)
    // Named in a photo field of the definition, as the page reads it, and not
    // only somewhere in the values.
    const signedAt = rows
      .filter((row) => {
        const definition = tradeForms.definitionFor(row.definition_key, row.definition_version)
        const values = readFormValues(row.values)

        return (
          definition !== null &&
          values !== null &&
          [...chosenPhotos(definition, values).keys()].some((each) => each.toLowerCase() === id)
        )
      })
      .map((row) => Number(row.change_sequence))

    if (signedAt.length === 0) {
      return false
    }

    // Only the version such a protocol shows: the newest the server had when
    // it was signed, as `shownVersions` picks it.
    const versions = await tx
      .select({ id: attachmentVersions.id, changeSequence: attachmentVersions.changeSequence })
      .from(attachmentVersions)
      .where(eq(attachmentVersions.attachmentId, id as never))
      .orderBy(desc(attachmentVersions.id))

    return signedAt.some(
      (at) => shownPhotoVersion(versions, (each) => each.changeSequence, at)?.id === version.id,
    )
  },
}
