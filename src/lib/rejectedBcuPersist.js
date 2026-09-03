'use strict';

/**
 * Compensating persist for BCU snapshot + optional Storage object.
 * Snapshot and institutions are two PostgREST inserts (not one SQL RPC).
 * If institutions fail, the snapshot row is deleted. If Storage cleanup
 * fails after a DB rollback attempt, that is logged (residual orphan file).
 */

const { randomUUID } = require('crypto');
const logger = require('./logger');
const { buildCreatedSnapshotResponse } = require('./rejectedOpsRead');
const {
  uploadRejectedBcuFile,
  removeRejectedBcuFile,
} = require('./rejectedBcuStorage');

function publicError(err) {
  if (err && err.statusCode) return err;
  const wrapped = new Error('Error interno');
  wrapped.statusCode = 500;
  wrapped.cause = err;
  return wrapped;
}

async function insertSnapshotRow(supabase, row) {
  const { data, error } = await supabase
    .from('rejected_bcu_snapshots')
    .insert(row)
    .select(
      'id, ci, period_label, consulted_on, source, storage_path, original_filename, content_type, file_size_bytes, created_by, created_at',
    )
    .single();
  if (error) {
    logger.error('rejected BCU snapshot insert failed', {
      error: error.message,
    });
    throw publicError(error);
  }
  return data;
}

async function insertInstitutionRows(supabase, rows) {
  const { data, error } = await supabase
    .from('rejected_bcu_institutions')
    .insert(rows)
    .select(
      'id, snapshot_id, institution_name, category, vigente_mn, vigente_me, moroso_mn, moroso_me, castigado_mn, castigado_me, contingencias_mn, contingencias_me, sort_order, created_at',
    );
  if (error) {
    logger.error('rejected BCU institutions insert failed', {
      error: error.message,
    });
    throw publicError(error);
  }
  return data || [];
}

async function deleteSnapshotRow(supabase, snapshotId) {
  const { error } = await supabase
    .from('rejected_bcu_snapshots')
    .delete()
    .eq('id', snapshotId);
  if (error) {
    logger.error('rejected BCU snapshot cleanup failed', {
      snapshotId: snapshotId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * @param {object} deps optional test doubles
 */
async function persistRejectedBcuSnapshot(input, deps) {
  const io = deps || {};
  const supabase = io.supabase;
  const upload =
    io.upload ||
    function (opts) {
      return uploadRejectedBcuFile(supabase, opts);
    };
  const remove =
    io.remove ||
    function (path) {
      return removeRejectedBcuFile(supabase, path);
    };
  const insertSnapshot = io.insertSnapshot || insertSnapshotRow;
  const insertInstitutions = io.insertInstitutions || insertInstitutionRows;
  const deleteSnapshot = io.deleteSnapshot || deleteSnapshotRow;
  const log = io.logger || logger;

  const snapshotId = input.snapshotId || randomUUID();
  const fileMeta = input.fileMeta || null;
  let uploadedPath = null;
  let snapshotInserted = false;

  try {
    if (fileMeta) {
      uploadedPath = await upload({
        snapshotId: snapshotId,
        objectId: input.fileObjectId || randomUUID(),
        ext: fileMeta.ext,
        buffer: fileMeta.buffer,
        contentType: fileMeta.contentType,
      });
    }

    const snapshotRow = {
      id: snapshotId,
      ci: input.ci,
      period_label: input.period_label,
      consulted_on: input.consulted_on,
      source: 'manual',
      storage_path: uploadedPath,
      original_filename: fileMeta ? fileMeta.originalFilename : null,
      content_type: fileMeta ? fileMeta.contentType : null,
      file_size_bytes: fileMeta ? fileMeta.fileSizeBytes : null,
      created_by: input.created_by,
    };

    const insertedSnapshot = await insertSnapshot(supabase, snapshotRow);
    snapshotInserted = true;

    const institutionPayload = (input.institutions || []).map(function (inst) {
      return {
        snapshot_id: snapshotId,
        institution_name: inst.institution_name,
        category: inst.category,
        vigente_mn: inst.vigente_mn,
        vigente_me: inst.vigente_me,
        moroso_mn: inst.moroso_mn,
        moroso_me: inst.moroso_me,
        castigado_mn: inst.castigado_mn,
        castigado_me: inst.castigado_me,
        contingencias_mn: inst.contingencias_mn,
        contingencias_me: inst.contingencias_me,
        sort_order: inst.sort_order,
      };
    });

    const insertedInstitutions = await insertInstitutions(
      supabase,
      institutionPayload,
    );

    return buildCreatedSnapshotResponse(
      insertedSnapshot,
      insertedInstitutions,
    );
  } catch (err) {
    if (snapshotInserted) {
      try {
        await deleteSnapshot(supabase, snapshotId);
      } catch (cleanErr) {
        log.error('rejected BCU snapshot cleanup failed', {
          snapshotId: snapshotId,
          error:
            cleanErr && cleanErr.message ? cleanErr.message : 'unknown',
        });
      }
    }
    if (uploadedPath) {
      try {
        await remove(uploadedPath);
      } catch (cleanErr) {
        log.error('rejected BCU storage cleanup failed', {
          storagePath: uploadedPath,
          error:
            cleanErr && cleanErr.message ? cleanErr.message : 'unknown',
        });
      }
    }
    throw err;
  }
}

module.exports = {
  persistRejectedBcuSnapshot,
  insertSnapshotRow,
  insertInstitutionRows,
  deleteSnapshotRow,
};
