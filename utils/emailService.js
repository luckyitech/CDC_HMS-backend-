const nodemailer = require('nodemailer');
const path = require('path');
const { code128Png } = require('./code128png');

const LOGO_PATH = path.join(__dirname, '../logo/cdc.jpg');

// ============================================================
// TRANSPORTER — single shared instance
// ============================================================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false, // TLS on port 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// ============================================================
// BASE HTML TEMPLATE
// Wraps any email body in consistent CDC HMS branding.
// ============================================================
const baseTemplate = (bodyHtml) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CDC HMS</title>
</head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:Arial,Helvetica,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td style="background-color:#0066CC;border-radius:12px 12px 0 0;padding:28px 32px;text-align:center;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <div style="display:inline-block;background-color:#FFFFFF;border-radius:50%;width:64px;height:64px;text-align:center;margin-bottom:12px;overflow:hidden;">
                      <img src="cid:cdclogo" alt="CDC HMS" style="width:64px;height:64px;object-fit:contain;display:block;" />
                    </div>
                    <p style="margin:0;color:#FFFFFF;font-size:22px;font-weight:700;letter-spacing:1px;">CDC HMS</p>
                    <p style="margin:4px 0 0 0;color:#B3D4FF;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Comprehensive Diabetes Care — Health Management System</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="background-color:#FFFFFF;padding:36px 32px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background-color:#F9FAFB;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;padding:20px 32px;text-align:center;">
              <p style="margin:0;color:#6B7280;font-size:12px;">
                This is an automated message from <strong>CDC HMS</strong>. Please do not reply to this email.
              </p>
              <p style="margin:8px 0 0 0;color:#9CA3AF;font-size:11px;">
                © ${new Date().getFullYear()} CDC HMS. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
`;

// ============================================================
// HELPER — coloured credential row
// ============================================================
const credentialRow = (label, value) => `
  <tr>
    <td style="padding:8px 12px;background-color:#F0F7FF;border-radius:6px;font-size:13px;color:#374151;">
      <strong style="color:#0066CC;">${label}:</strong>&nbsp;&nbsp;${value}
    </td>
  </tr>
  <tr><td style="height:6px;"></td></tr>
`;

// Monospace blue — IDs, appointment numbers, UHIDs
const monoBlue = (val) => `<strong style="font-family:monospace;font-size:15px;color:#0066CC;">${val}</strong>`;

// Monospace dark — temporary passwords
const monoDark = (val) => `<strong style="font-family:monospace;font-size:15px;letter-spacing:1px;color:#111827;">${val}</strong>`;

// Format a date value for appointment emails
const fmtDate = (date) => new Date(date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

// ============================================================
// HELPER — primary button
// ============================================================
const primaryButton = (label, url) => `
  <table cellpadding="0" cellspacing="0" style="margin:24px auto 0 auto;">
    <tr>
      <td style="background-color:#0066CC;border-radius:8px;padding:14px 32px;text-align:center;">
        <a href="${url}" style="color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none;display:block;">${label}</a>
      </td>
    </tr>
  </table>
  <p style="text-align:center;font-size:11px;color:#9CA3AF;margin:10px 0 0 0;">
    Or copy this link: <a href="${url}" style="color:#0066CC;">${url}</a>
  </p>
`;

// ============================================================
// HELPER — warning / info banner
// ============================================================
const infoBanner = (text) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
    <tr>
      <td style="background-color:#FFF7ED;border-left:4px solid #F97316;border-radius:0 6px 6px 0;padding:12px 16px;">
        <p style="margin:0;font-size:13px;color:#92400E;">${text}</p>
      </td>
    </tr>
  </table>
`;

// ============================================================
// HELPER — patient identification barcode
// Every patient-facing email (welcome, email-updated, appointment
// confirmations/cancellations, and any FUTURE reminder emails) should
// include barcodeBlock(uhid) in the body and barcodeAttachment(uhid)
// as the sendEmail extraAttachments — the patient can then be
// identified at reception from any email we have ever sent them.
// ============================================================
const barcodeBlock = (uhid) => `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
    <tr>
      <td align="center" style="background-color:#FFFFFF;border:2px solid #E5E7EB;border-radius:12px;padding:18px;">
        <p style="margin:0 0 8px 0;font-size:12px;color:#6B7280;">Show this barcode at reception to be identified instantly</p>
        <img src="cid:patientbarcode" alt="Barcode ${uhid}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />
        <p style="margin:8px 0 0 0;font-family:monospace;font-size:15px;letter-spacing:3px;color:#111827;">${uhid}</p>
      </td>
    </tr>
  </table>
`;

// cid attachment for barcodeBlock — [] if generation fails: an email must
// never fail because of its barcode.
const barcodeAttachment = (uhid) => {
  try {
    return [{ filename: `${uhid}-barcode.png`, content: code128Png(uhid), cid: 'patientbarcode' }];
  } catch (err) {
    console.warn('[EmailService] barcode generation failed:', err.message);
    return [];
  }
};

// ============================================================
// SEND — base function (all emails go through here)
// ============================================================
const sendEmail = async (to, subject, html, extraAttachments = []) => {
  try {
    await transporter.sendMail({
      from: `CDC HMS <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
      attachments: [{
        filename: "cdc.jpg",
        path: LOGO_PATH,
        cid: "cdclogo",
      }, ...extraAttachments],
    });
  } catch (err) {
    // Log but don't crash the request — email failure should never block account creation
    console.warn(`[EmailService] Failed to send email to ${to}:`, err.message);
  }
};

// ============================================================
// EMAIL: Welcome — Staff / Doctor / Lab Tech
// Called when admin creates a new staff member account
// ============================================================
const sendStaffWelcomeEmail = async ({ to, name, role, tempPassword }) => {
  const roleLabel = { doctor: 'Doctor', staff: 'Staff Member', lab: 'Lab Technician', admin: 'Administrator' }[role] || role;
  const loginPath = { doctor: '/login/doctor', staff: '/login/staff', lab: '/login/lab', admin: '/login/admin' }[role] || '/login';

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Welcome to CDC HMS, ${name}!</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Your <strong>${roleLabel}</strong> account has been created by the administrator.
      Use the credentials below to log in for the first time.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Role', roleLabel)}
      ${credentialRow('Email', to)}
      ${credentialRow('Temporary Password', monoDark(tempPassword))}
    </table>

    ${primaryButton('Log In to CDC HMS', `${FRONTEND_URL}${loginPath}`)}

    ${infoBanner(`<strong>Important:</strong> This is a temporary password. To change it, go to the login page and click <strong>"Forgot Password"</strong>, then follow the instructions sent to this email address. Do not share this password with anyone.`)}
  `;

  await sendEmail(to, `Welcome to CDC HMS — Your ${roleLabel} Account`, baseTemplate(body));
};

// ============================================================
// EMAIL: Welcome — Patient
// Called when staff / admin registers a new patient
// ============================================================
const sendPatientWelcomeEmail = async ({ to, name, uhid, tempPassword }) => {
  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Welcome to CDC HMS, ${name}!</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Your patient account has been registered at the <strong>Comprehensive Diabetes Care Health Management System</strong>.
      You can now access the patient portal using the credentials below.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Patient ID (UHID)', monoBlue(uhid))}
      ${credentialRow('Email', to)}
      ${credentialRow('Temporary Password', monoDark(tempPassword))}
    </table>

    ${primaryButton('Access Patient Portal', `${FRONTEND_URL}/login/patient`)}

    <p style="margin:28px 0 0 0;font-size:13px;color:#374151;"><strong>What you can do in the patient portal:</strong></p>
    <ul style="margin:8px 0 0 0;padding-left:20px;font-size:13px;color:#6B7280;line-height:1.8;">
      <li>Log your daily blood sugar readings</li>
      <li>View your blood sugar trends and charts</li>
      <li>Check prescriptions from your doctor</li>
      <li>Book and manage appointments</li>
      <li>Access your lab results and medical documents</li>
    </ul>

    ${barcodeBlock(uhid)}

    ${infoBanner('<strong>Important:</strong> This is a temporary password. To change it, go to the patient portal login page and click <strong>"Forgot Password"</strong>, then follow the instructions sent to this email address. Keep your account secure — do not share this password with anyone.')}
  `;

  await sendEmail(to, 'Welcome to CDC HMS — Your Patient Portal Account', baseTemplate(body), barcodeAttachment(uhid));
};

// ============================================================
// EMAIL: Email Address Updated — Patient
// Called when admin changes a patient's login email
// ============================================================
const sendEmailUpdatedEmail = async ({ to, name, uhid }) => {
  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Your Login Email Has Been Updated</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${name}</strong>, the email address linked to your CDC HMS patient portal account has been updated by the clinic.
      You can now log in using this email address.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Patient ID (UHID)', monoBlue(uhid))}
      ${credentialRow('New Login Email', to)}
    </table>

    ${primaryButton('Access Patient Portal', `${FRONTEND_URL}/login/patient`)}

    ${barcodeBlock(uhid)}

    ${infoBanner('Your password has not changed. If you did not expect this update or need assistance, please contact the clinic directly.')}
  `;

  await sendEmail(to, 'CDC HMS — Your Login Email Has Been Updated', baseTemplate(body), barcodeAttachment(uhid));
};

// ============================================================
// EMAIL: Password Reset
// Called when user requests a password reset
// ============================================================
const sendPasswordResetEmail = async ({ to, name, resetToken }) => {
  const resetUrl = `${FRONTEND_URL}/forgot-password?token=${resetToken}`;

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Password Reset Request</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${name}</strong>, we received a request to reset the password for your CDC HMS account.
      Click the button below to set a new password.
    </p>

    ${primaryButton('Reset My Password', resetUrl)}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
      <tr>
        <td style="background-color:#FEF2F2;border-left:4px solid #EF4444;border-radius:0 6px 6px 0;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#991B1B;">
            <strong>This link will expire in 1 hour.</strong> If you did not request a password reset,
            please ignore this email — your password will remain unchanged.
          </p>
        </td>
      </tr>
    </table>
  `;

  await sendEmail(to, 'CDC HMS — Password Reset Request', baseTemplate(body));
};


// ============================================================
// EMAIL: Appointment Confirmation — Patient
// Called when a patient successfully books an appointment
// ============================================================
const sendAppointmentConfirmationEmail = async ({ to, patientName, doctorName, specialty, date, timeSlot, appointmentType, appointmentNumber, reason, uhid }) => {
  const formattedDate = fmtDate(date);

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Appointment Confirmed!</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${patientName}</strong>, your appointment has been successfully booked. Here are your appointment details.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Appointment No.', monoBlue(appointmentNumber))}
      ${credentialRow('Doctor', doctorName)}
      ${credentialRow('Specialty', specialty || 'General')}
      ${credentialRow('Date', formattedDate)}
      ${credentialRow('Time', timeSlot)}
      ${credentialRow('Type', appointmentType)}
      ${reason ? credentialRow('Reason', reason) : ''}
    </table>

    ${uhid ? barcodeBlock(uhid) : ''}

    ${infoBanner('Please arrive 10 minutes before your scheduled time. To cancel or reschedule, log in to the patient portal.')}
  `;

  await sendEmail(to, `Appointment Confirmed — ${formattedDate} at ${timeSlot}`, baseTemplate(body), uhid ? barcodeAttachment(uhid) : []);
};

// ============================================================
// EMAIL: New Appointment Notification — Doctor
// Called when a patient books an appointment with the doctor
// ============================================================
const sendDoctorAppointmentNotificationEmail = async ({ to, doctorName, patientName, uhid, date, timeSlot, appointmentType, appointmentNumber, reason }) => {
  const formattedDate = fmtDate(date);

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">New Appointment Booked</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${doctorName}</strong>, a patient has booked an appointment with you. Here are the details.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Appointment No.', monoBlue(appointmentNumber))}
      ${credentialRow('Patient', patientName)}
      ${credentialRow('Patient ID (UHID)', monoBlue(uhid))}
      ${credentialRow('Date', formattedDate)}
      ${credentialRow('Time', timeSlot)}
      ${credentialRow('Type', appointmentType)}
      ${reason ? credentialRow('Reason / Chief Complaint', reason) : ''}
    </table>

    ${infoBanner('This appointment will appear on your dashboard. You can view full patient details by logging in to the doctor portal.')}
  `;

  await sendEmail(to, `New Appointment: ${patientName} — ${formattedDate} at ${timeSlot}`, baseTemplate(body));
};

// ============================================================
// EMAIL: Appointment Cancellation — Patient
// Called when an appointment is cancelled
// ============================================================
const sendAppointmentCancellationEmail = async ({ to, patientName, doctorName, date, timeSlot, appointmentType, appointmentNumber, uhid }) => {
  const formattedDate = fmtDate(date);

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Appointment Cancelled</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${patientName}</strong>, your appointment has been cancelled. Below are the details of the cancelled appointment.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Appointment No.', monoBlue(appointmentNumber))}
      ${credentialRow('Doctor', doctorName)}
      ${credentialRow('Date', formattedDate)}
      ${credentialRow('Time', timeSlot)}
      ${credentialRow('Type', appointmentType)}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr>
        <td style="background-color:#FEF2F2;border-left:4px solid #EF4444;border-radius:0 6px 6px 0;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#991B1B;">
            This appointment has been cancelled and removed from your schedule.
            If you did not request this cancellation or need further assistance, please contact the clinic directly.
          </p>
        </td>
      </tr>
    </table>

    ${uhid ? barcodeBlock(uhid) : ''}

    ${infoBanner('Need to reschedule? Log in to the patient portal to book a new appointment at your convenience.')}
  `;

  await sendEmail(to, `Appointment Cancelled — ${formattedDate} at ${timeSlot}`, baseTemplate(body), uhid ? barcodeAttachment(uhid) : []);
};

// ============================================================
// EMAIL: Appointment Cancellation Notification — Doctor
// Called when a patient's appointment is cancelled
// ============================================================
const sendDoctorAppointmentCancellationEmail = async ({ to, doctorName, patientName, uhid, date, timeSlot, appointmentType, appointmentNumber }) => {
  const formattedDate = fmtDate(date);

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Appointment Cancelled</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${doctorName}</strong>, an appointment in your schedule has been cancelled. Here are the details.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Appointment No.', monoBlue(appointmentNumber))}
      ${credentialRow('Patient', patientName)}
      ${credentialRow('Patient ID (UHID)', monoBlue(uhid))}
      ${credentialRow('Date', formattedDate)}
      ${credentialRow('Time', timeSlot)}
      ${credentialRow('Type', appointmentType)}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr>
        <td style="background-color:#FFF7ED;border-left:4px solid #F97316;border-radius:0 6px 6px 0;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#92400E;">
            This time slot has been freed in your schedule. Another patient may be booked for this slot.
          </p>
        </td>
      </tr>
    </table>
  `;

  await sendEmail(to, `Appointment Cancelled: ${patientName} — ${formattedDate} at ${timeSlot}`, baseTemplate(body));
};

// ============================================================
// EMAIL: Patient Barcode Card
// Called when staff / doctor / admin emails a patient their
// identification barcode. The Code128 PNG is rendered
// server-side (utils/code128png) and embedded inline via cid;
// it is also attached so the patient can save or print it.
// ============================================================
const sendPatientBarcodeEmail = async ({ to, name, uhid, dob, doctor, pngBuffer }) => {
  const dobRow = dob
    ? credentialRow('Date of Birth', new Date(dob).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))
    : '';

  const doctorRow = doctor
    ? credentialRow('Doctor', doctor)
    : '';

  const body = `
    <h2 style="margin:0 0 8px 0;font-size:20px;color:#111827;">Your Patient Identification Card</h2>
    <p style="margin:0 0 24px 0;font-size:14px;color:#6B7280;">
      Hi <strong>${name}</strong>, this is your identification barcode for the
      <strong>Comprehensive Diabetes Centre</strong>. Show it at reception &mdash;
      on your phone or printed &mdash; and we'll find your record instantly.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0">
      ${credentialRow('Patient ID (UHID)', monoBlue(uhid))}
      ${dobRow}
      ${doctorRow}
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr>
        <td align="center" style="background-color:#FFFFFF;border:2px solid #E5E7EB;border-radius:12px;padding:24px;">
          <img src="cid:patientbarcode" alt="Barcode ${uhid}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />
          <p style="margin:10px 0 0 0;font-family:monospace;font-size:16px;letter-spacing:3px;color:#111827;">${uhid}</p>
        </td>
      </tr>
    </table>

    ${infoBanner('Keep this email &mdash; the barcode does not expire. The attached image can be saved to your phone or printed. This code only identifies you at the clinic; it cannot be used to access your medical records.')}
  `;

  await sendEmail(to, 'CDC HMS — Your Patient Identification Barcode', baseTemplate(body), [
    {
      filename: `${uhid}-barcode.png`,
      content: pngBuffer,
      cid: 'patientbarcode',
    },
  ]);
};

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  sendStaffWelcomeEmail,
  sendPatientWelcomeEmail,
  sendEmailUpdatedEmail,
  sendPasswordResetEmail,
  sendAppointmentConfirmationEmail,
  sendDoctorAppointmentNotificationEmail,
  sendAppointmentCancellationEmail,
  sendDoctorAppointmentCancellationEmail,
  sendPatientBarcodeEmail,
};