'use strict';

// Communications Inbox (WhatsApp; channel-generic for Messenger/Instagram later).
// Eight new tables + two column additions, all guarded and reversible.
//
//   MessagingChannels             a clinic messaging endpoint (a WhatsApp number)
//   ExternalOrganisations         a lab / pharmacy / insurer
//   ExternalOrganisationContacts  that party's WhatsApp numbers + email senders
//   Conversations                 one thread with one external party on one channel
//   ConversationMessages          one message (in / out / internal note)
//   ConversationEscalations       a thread raised to a doctor (internal)
//   ConversationReminders         a follow-up a user sets on a thread
//   MessageTemplates              cached approved Meta templates
//   + Patients.whatsappOptIn / whatsappOptInAt / whatsappOptInSource
//   + LabInboxItems.source / sourceMessageId  (WhatsApped lab reports mirror in)
//
// Every FK is onUpdate CASCADE. A REQUIRED parent link (channelId,
// conversationId, organisationId) is onDelete CASCADE; every nullable
// patient/user/document/message ref is onDelete SET NULL so the audit row
// survives a merge/removal. Guards make this idempotent whether the schema was
// built by sync() (local/test first boot) or by this migration (prod).
//
// A4 note: the Patient and LabInboxItem MODELS list the new columns, so if this
// migration is ever skipped on prod every query on those models 500s. The Part E
// release gate must print this migration `up`.

const norm = (t) => (typeof t === 'string' ? t : t.tableName).toLowerCase();
const tableExists = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map(norm).includes(name.toLowerCase());
};
const columnExists = async (qi, table, column) => {
  try {
    const desc = await qi.describeTable(table);
    return Object.prototype.hasOwnProperty.call(desc, column);
  } catch { return false; }
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const timestamps = {
      createdAt: { type: S.DATE, allowNull: false },
      updatedAt: { type: S.DATE, allowNull: false },
    };
    const id = { type: S.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false };

    const ref = (model, { allowNull = true, onDelete = 'SET NULL' } = {}) => ({
      type: S.INTEGER, allowNull,
      references: { model, key: 'id' }, onUpdate: 'CASCADE', onDelete,
    });
    const userRef    = () => ref('Users');
    const patientRef = () => ref('Patients');

    const create = async (name, columns, indexes = []) => {
      if (await tableExists(queryInterface, name)) return;
      await queryInterface.createTable(name, { id, ...columns, ...timestamps });
      for (const ix of indexes) {
        await queryInterface.addIndex(name, ix.fields, { unique: !!ix.unique, name: ix.name });
      }
    };

    // 1) MessagingChannels ---------------------------------------------------
    await create('MessagingChannels', {
      channel:        { type: S.ENUM('whatsapp', 'messenger', 'instagram'), allowNull: false, defaultValue: 'whatsapp' },
      externalId:     { type: S.STRING, allowNull: false },
      displayPhone:   { type: S.STRING, allowNull: true },
      label:          { type: S.STRING, allowNull: true },
      wabaId:         { type: S.STRING, allowNull: true },
      isActive:       { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      qualityRating:  { type: S.STRING, allowNull: true },
      lastInboundAt:  { type: S.DATE, allowNull: true },
      lastOutboundAt: { type: S.DATE, allowNull: true },
    }, [
      { unique: true, fields: ['externalId'], name: 'unique_messaging_channel_external' },
      { fields: ['channel'], name: 'messaging_channel_channel' },
    ]);

    // 2) ExternalOrganisations ----------------------------------------------
    await create('ExternalOrganisations', {
      type:     { type: S.ENUM('lab', 'pharmacy', 'insurer', 'other'), allowNull: false, defaultValue: 'lab' },
      name:     { type: S.STRING, allowNull: false },
      notes:    { type: S.STRING, allowNull: true },
      isActive: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
    }, [
      { fields: ['type'], name: 'external_org_type' },
    ]);

    // 3) ExternalOrganisationContacts ---------------------------------------
    await create('ExternalOrganisationContacts', {
      organisationId: ref('ExternalOrganisations', { allowNull: false, onDelete: 'CASCADE' }),
      kind:  { type: S.ENUM('whatsapp', 'email', 'emailDomain'), allowNull: false },
      value: { type: S.STRING, allowNull: false },
      label: { type: S.STRING, allowNull: true },
    }, [
      { unique: true, fields: ['kind', 'value'], name: 'unique_org_contact_kind_value' },
      { fields: ['organisationId'], name: 'org_contact_organisation' },
    ]);

    // 4) Conversations -------------------------------------------------------
    await create('Conversations', {
      channelId:      ref('MessagingChannels', { allowNull: false, onDelete: 'CASCADE' }),
      externalUserId: { type: S.STRING, allowNull: false },
      profileName:    { type: S.STRING, allowNull: true },
      contactType:    { type: S.ENUM('patient', 'lab', 'organisation'), allowNull: false, defaultValue: 'patient' },
      contactOrgId:   ref('ExternalOrganisations'),
      patientId:      patientRef(),
      linkMethod:     { type: S.ENUM('auto', 'manual'), allowNull: true },
      linkedById:     userRef(),
      linkedAt:       { type: S.DATE, allowNull: true },
      suggestedPatientIds: { type: S.JSON, allowNull: true },
      assignedToId:   userRef(),
      status:         { type: S.ENUM('open', 'closed', 'archived'), allowNull: false, defaultValue: 'open' },
      topic:          { type: S.STRING, allowNull: true },
      topicSource:    { type: S.ENUM('auto', 'manual'), allowNull: true },
      pinnedAt:       { type: S.DATE, allowNull: true },
      pinnedById:     userRef(),
      lastInboundAt:  { type: S.DATE, allowNull: true },
      lastOutboundAt: { type: S.DATE, allowNull: true },
      windowExpiresAt:{ type: S.DATE, allowNull: true },
      unreadCount:    { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      openQueryCount: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      lastMessageAt:      { type: S.DATE, allowNull: true },
      lastMessagePreview: { type: S.STRING(160), allowNull: true },
    }, [
      { unique: true, fields: ['channelId', 'externalUserId'], name: 'unique_conversation_channel_user' },
      { fields: ['patientId'], name: 'conversation_patient' },
      { fields: ['status', 'lastMessageAt'], name: 'conversation_status_last' },
      { fields: ['assignedToId'], name: 'conversation_assigned' },
      { fields: ['contactType'], name: 'conversation_contact_type' },
      { fields: ['pinnedAt'], name: 'conversation_pinned' },
    ]);

    // 5) ConversationMessages ------------------------------------------------
    await create('ConversationMessages', {
      conversationId: ref('Conversations', { allowNull: false, onDelete: 'CASCADE' }),
      channel:        { type: S.ENUM('whatsapp', 'messenger', 'instagram'), allowNull: false, defaultValue: 'whatsapp' },
      patientId:      patientRef(),
      direction:      { type: S.ENUM('in', 'out', 'internal'), allowNull: false },
      externalMessageId: { type: S.STRING, allowNull: false },
      type:    { type: S.STRING, allowNull: true },
      body:    { type: S.TEXT, allowNull: true },
      caption: { type: S.TEXT, allowNull: true },
      mediaId:        { type: S.STRING, allowNull: true },
      mediaMime:      { type: S.STRING, allowNull: true },
      mediaFileName:  { type: S.STRING, allowNull: true },
      mediaPath:      { type: S.STRING, allowNull: true },
      mediaSize:      { type: S.INTEGER, allowNull: true },
      mediaEncrypted: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      replyToExternalId: { type: S.STRING, allowNull: true },
      templateName:   { type: S.STRING, allowNull: true },
      templateParams: { type: S.JSON, allowNull: true },
      status:   { type: S.ENUM('received', 'queued', 'sent', 'delivered', 'read', 'failed'), allowNull: false, defaultValue: 'received' },
      statusAt: { type: S.DATE, allowNull: true },
      errorCode:    { type: S.STRING, allowNull: true },
      errorMessage: { type: S.STRING, allowNull: true },
      billable:        { type: S.BOOLEAN, allowNull: true },
      pricingCategory: { type: S.STRING, allowNull: true },
      sentById:          userRef(),
      externalTimestamp: { type: S.DATE, allowNull: true },
      medicalDocumentId: ref('MedicalDocuments'),
      appointmentId:     ref('Appointments'),
      queryStatus:    { type: S.ENUM('open', 'completed'), allowNull: true },
      resolutionKind: { type: S.ENUM('answered', 'appointment_booked', 'document_filed', 'referred', 'no_action'), allowNull: true },
      resolutionNote: { type: S.TEXT, allowNull: true },
      resolvedById:   userRef(),
      resolvedAt:     { type: S.DATE, allowNull: true },
      reopenedById:   userRef(),
      reopenedAt:     { type: S.DATE, allowNull: true },
    }, [
      { unique: true, fields: ['externalMessageId'], name: 'unique_conv_message_external' },
      { fields: ['conversationId', 'createdAt'], name: 'conv_message_conversation' },
      { fields: ['patientId', 'createdAt'], name: 'conv_message_patient' },
      { fields: ['status'], name: 'conv_message_status' },
      { fields: ['direction', 'createdAt'], name: 'conv_message_direction' },
      { fields: ['queryStatus'], name: 'conv_message_query' },
      { fields: ['sentById'], name: 'conv_message_sent_by' },
    ]);

    // 6) ConversationEscalations --------------------------------------------
    await create('ConversationEscalations', {
      conversationId: ref('Conversations', { allowNull: false, onDelete: 'CASCADE' }),
      messageId:      ref('ConversationMessages'),
      escalatedById:  userRef(),
      escalatedToId:  userRef(),
      note:           { type: S.TEXT, allowNull: true },
      status:         { type: S.ENUM('open', 'resolved'), allowNull: false, defaultValue: 'open' },
      firstDoctorReplyAt: { type: S.DATE, allowNull: true },
      resolvedById:   userRef(),
      resolvedAt:     { type: S.DATE, allowNull: true },
    }, [
      { fields: ['escalatedToId', 'status'], name: 'escalation_assignee_status' },
      { fields: ['conversationId'], name: 'escalation_conversation' },
    ]);

    // 7) ConversationReminders ----------------------------------------------
    await create('ConversationReminders', {
      conversationId: ref('Conversations', { allowNull: false, onDelete: 'CASCADE' }),
      patientId:      patientRef(),
      setById:        userRef(),
      forUserId:      userRef(),
      remindAt:       { type: S.DATE, allowNull: false },
      note:           { type: S.STRING, allowNull: true },
      status:         { type: S.ENUM('pending', 'done', 'snoozed', 'cancelled'), allowNull: false, defaultValue: 'pending' },
      snoozedUntil:   { type: S.DATE, allowNull: true },
      doneById:       userRef(),
      doneAt:         { type: S.DATE, allowNull: true },
    }, [
      { fields: ['forUserId', 'status', 'remindAt'], name: 'reminder_for_status_time' },
      { fields: ['conversationId'], name: 'reminder_conversation' },
    ]);

    // 8) MessageTemplates ----------------------------------------------------
    await create('MessageTemplates', {
      channelKey: { type: S.STRING, allowNull: false, defaultValue: 'whatsapp' },
      name:       { type: S.STRING, allowNull: false },
      language:   { type: S.STRING, allowNull: false, defaultValue: 'en' },
      category:   { type: S.STRING, allowNull: true },
      status:     { type: S.STRING, allowNull: true },
      components: { type: S.JSON, allowNull: true },
      metaId:     { type: S.STRING, allowNull: true },
      syncedAt:   { type: S.DATE, allowNull: true },
    }, [
      { unique: true, fields: ['name', 'language'], name: 'unique_message_template_name_lang' },
    ]);

    // 9) Patients — WhatsApp consent ----------------------------------------
    if (await tableExists(queryInterface, 'Patients')) {
      if (!(await columnExists(queryInterface, 'Patients', 'whatsappOptIn'))) {
        await queryInterface.addColumn('Patients', 'whatsappOptIn', { type: S.BOOLEAN, allowNull: false, defaultValue: false });
      }
      if (!(await columnExists(queryInterface, 'Patients', 'whatsappOptInAt'))) {
        await queryInterface.addColumn('Patients', 'whatsappOptInAt', { type: S.DATE, allowNull: true });
      }
      if (!(await columnExists(queryInterface, 'Patients', 'whatsappOptInSource'))) {
        await queryInterface.addColumn('Patients', 'whatsappOptInSource', { type: S.STRING, allowNull: true });
      }
    }

    // 10) LabInboxItems — source of a report --------------------------------
    if (await tableExists(queryInterface, 'LabInboxItems')) {
      if (!(await columnExists(queryInterface, 'LabInboxItems', 'source'))) {
        await queryInterface.addColumn('LabInboxItems', 'source', { type: S.ENUM('email', 'whatsapp'), allowNull: false, defaultValue: 'email' });
      }
      if (!(await columnExists(queryInterface, 'LabInboxItems', 'sourceMessageId'))) {
        await queryInterface.addColumn('LabInboxItems', 'sourceMessageId', {
          type: S.INTEGER, allowNull: true,
          references: { model: 'ConversationMessages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
        });
      }
    }
  },

  async down(queryInterface) {
    // Reverse order: drop the LabInboxItems FK column first (references
    // ConversationMessages), then the added Patient columns, then the tables
    // children-first.
    const dropColumn = async (table, column) => {
      if (await tableExists(queryInterface, table) && await columnExists(queryInterface, table, column)) {
        await queryInterface.removeColumn(table, column);
      }
    };
    await dropColumn('LabInboxItems', 'sourceMessageId');
    await dropColumn('LabInboxItems', 'source');
    await dropColumn('Patients', 'whatsappOptInSource');
    await dropColumn('Patients', 'whatsappOptInAt');
    await dropColumn('Patients', 'whatsappOptIn');

    const drop = async (name) => { if (await tableExists(queryInterface, name)) await queryInterface.dropTable(name); };
    await drop('MessageTemplates');
    await drop('ConversationReminders');
    await drop('ConversationEscalations');
    await drop('ConversationMessages');
    await drop('Conversations');
    await drop('ExternalOrganisationContacts');
    await drop('ExternalOrganisations');
    await drop('MessagingChannels');
  },
};
