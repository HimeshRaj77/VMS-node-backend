const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');
const { Resend } = require('resend');

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// @desc    Register a new admin
// @route   POST /api/admin/signup
// @access  Public
const signupAdmin = async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Please fill all required fields' });
  }

  try {
    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ message: 'An admin account with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const admin = await prisma.admin.create({
      data: {
        fullName,
        email,
        password: hashedPassword,
        role: 'admin',
      },
    });

    res.status(201).json({
      id: admin.id,
      fullName: admin.fullName,
      email: admin.email,
      token: generateToken(admin.id),
    });
  } catch (error) {
    console.error('Admin signup error:', error);
    res.status(500).json({ message: 'Server error during admin registration' });
  }
};

// @desc    Login admin
// @route   POST /api/admin/login
// @access  Public
const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { email } });

    if (!admin || admin.role !== 'admin') {
      return res.status(401).json({ message: 'Invalid credentials or insufficient permissions' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    res.json({
      id: admin.id,
      fullName: admin.fullName,
      email: admin.email,
      token: generateToken(admin.id),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Server error during admin login' });
  }
};

// @desc    Get all agencies (admin only)
// @route   GET /api/admin/agencies
// @access  Admin
const getAllAgencies = async (req, res) => {
  try {
    const agencies = await prisma.agency.findMany({
      select: {
        id: true,
        agencyName: true,
        contactPerson: true,
        email: true,
        phone: true,
        gstNumber: true,
        city: true,
        state: true,
        createdAt: true,
        quotation: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Map `quotation` to `_count: { quotations: q ? 1 : 0 }` for backwards compatibility with the admin UI
    const mappedAgencies = agencies.map(agency => {
      const copy = {
        ...agency,
        _count: {
          quotations: agency.quotation ? 1 : 0
        }
      };
      delete copy.quotation;
      return copy;
    });

    res.json(mappedAgencies);
  } catch (error) {
    console.error('Get agencies error:', error);
    res.status(500).json({ message: 'Server error fetching agencies' });
  }
};

// @desc    Get all quotations (admin only)
// @route   GET /api/admin/quotations
// @access  Admin
const getAllQuotations = async (req, res) => {
  try {
    const quotations = await prisma.quotation.findMany({
      include: {
        agency: {
          select: { agencyName: true, email: true, city: true },
        },
        StructuredQuotation: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Normalize StructuredQuotation to structuredQuotation camelCase for the frontend
    const response = quotations.map((q) => {
      const copy = {
        ...q,
        structuredQuotation: q.StructuredQuotation || null,
      };
      delete copy.StructuredQuotation;
      return copy;
    });

    res.json(response);
  } catch (error) {
    console.error('Get quotations error:', error);
    res.status(500).json({ message: 'Server error fetching quotations' });
  }
};

// @desc    Get allocations for a specific date and zone
// @route   GET /api/admin/allocations
// @access  Admin
const getAllAllocations = async (req, res) => {
  try {
    const dbAllocations = await prisma.allocation.findMany({
      include: {
        worker: {
          include: {
            agency: {
              select: {
                agencyName: true
              }
            }
          }
        }
      }
    });

    const allocationsMap = {};

    dbAllocations.forEach(alloc => {
      const key = `${alloc.date}_${alloc.zone}`;
      if (!allocationsMap[key]) {
        allocationsMap[key] = {};
      }

      const w = alloc.worker;
      if (w) {
        allocationsMap[key][alloc.slotKey] = {
          id: w.id,
          name: w.name,
          gender: w.gender || 'Male',
          dept: w.department,
          agency: w.agency?.agencyName || 'Independent Agency',
          ratePerDay: w.ratePerDay,
          role: w.role,
          dob: w.dob,
          aadharNumber: w.aadharNumber
        };
      }
    });

    res.json(allocationsMap);
  } catch (error) {
    console.error('Get allocations error:', error);
    res.status(500).json({ message: 'Server error fetching allocations' });
  }
};

// @desc    Save allocations
// @route   POST /api/admin/allocations
// @access  Admin
const saveAllocations = async (req, res) => {
  const { allocations } = req.body;

  if (!allocations) {
    return res.status(400).json({ message: 'No allocations provided' });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Clear all existing allocations
      await tx.allocation.deleteMany();

      // Collect new allocations
      const insertData = [];

      Object.keys(allocations).forEach(dateZoneKey => {
        const [date, zone] = dateZoneKey.split('_');
        const slotMap = allocations[dateZoneKey] || {};

        Object.keys(slotMap).forEach(slotKey => {
          const worker = slotMap[slotKey];
          if (worker && worker.id) {
            insertData.push({
              date,
              zone,
              slotKey,
              workerId: worker.id
            });
          }
        });
      });

      if (insertData.length > 0) {
        await tx.allocation.createMany({
          data: insertData
        });
      }
    });

    // Try sending email notifications using Resend
    let emailStatus = [];
    try {
      emailStatus = await sendAllocationEmails(allocations);
    } catch (emailErr) {
      console.error('[Resend Email] Overall dispatch failed:', emailErr);
    }

    res.json({ 
      message: 'Allocations saved successfully to database', 
      allocations, 
      emailStatus 
    });
  } catch (error) {
    console.error('Save allocations error:', error);
    res.status(500).json({ message: 'Server error saving allocations to database' });
  }
};

/**
 * Creative HTML Email generator for VMS dispatch notification
 */
const generateCreativeEmailHtml = (agency, totalWorkers, departmentCounts, list) => {
  const serviceCardsHtml = Object.keys(departmentCounts).map(dept => {
    let emoji = '🛠️';
    const lowerDept = dept.toLowerCase();
    if (lowerDept.includes('sec')) emoji = '🛡️';
    else if (lowerDept.includes('house') || lowerDept.includes('clean')) emoji = '🧹';
    else if (lowerDept.includes('elect')) emoji = '⚡';
    else if (lowerDept.includes('plumb')) emoji = '🚰';
    else if (lowerDept.includes('admin') || lowerDept.includes('office')) emoji = '💼';
    else if (lowerDept.includes('food') || lowerDept.includes('cater')) emoji = '🍽️';

    return `
      <div style="background-color: #fcf6f5; border: 2px solid #1f2937; padding: 12px 16px; margin: 8px 0; border-radius: 4px; box-shadow: 2px 2px 0px #1f2937; display: inline-block; min-width: 200px; margin-right: 12px; vertical-align: top;">
        <span style="font-size: 20px; margin-right: 8px; display: inline-block; vertical-align: middle;">${emoji}</span>
        <div style="display: inline-block; vertical-align: middle; text-align: left;">
          <div style="font-weight: 800; font-size: 11px; text-transform: uppercase; color: #6b7280; letter-spacing: 0.05em;">${dept}</div>
          <div style="font-size: 18px; font-weight: 900; color: #8B3A2A;">${departmentCounts[dept]} Assigned</div>
        </div>
      </div>
    `;
  }).join('');

  const rosterRowsHtml = list.map((item, index) => {
    const w = item.worker;
    const genderBadge = w.gender === 'Female' 
      ? '<span style="background-color: #fdf2f8; border: 1px solid #db2777; color: #db2777; font-size: 11px; font-weight: bold; padding: 2px 6px; border-radius: 9999px;">Female</span>'
      : '<span style="background-color: #eff6ff; border: 1px solid #2563eb; color: #2563eb; font-size: 11px; font-weight: bold; padding: 2px 6px; border-radius: 9999px;">Male</span>';

    return `
      <tr style="background-color: ${index % 2 === 0 ? '#ffffff' : '#f9fafb'}; border-bottom: 2px solid #1f2937;">
        <td style="padding: 12px; font-weight: bold; border-right: 2px solid #1f2937; color: #1f2937; font-size: 13px;">${item.date}</td>
        <td style="padding: 12px; border-right: 2px solid #1f2937; color: #1f2937; font-size: 13px;">
          <span style="background-color: #f3f4f6; padding: 3px 8px; border: 1px solid #1f2937; font-size: 11px; font-weight: bold; border-radius: 2px;">${item.zone}</span>
        </td>
        <td style="padding: 12px; border-right: 2px solid #1f2937; font-size: 13px;">
          <div style="font-weight: bold; color: #1f2937; text-align: left;">${w.name}</div>
          <div style="margin-top: 4px; text-align: left;">${genderBadge}</div>
        </td>
        <td style="padding: 12px; border-right: 2px solid #1f2937; font-family: monospace; font-size: 12px; color: #4b5563;">
          ${w.aadharNumber ? w.aadharNumber.replace(/(\d{4})/g, '$1 ').trim() : 'N/A'}
        </td>
        <td style="padding: 12px; border-right: 2px solid #1f2937; font-size: 13px; text-align: left;">
          <div style="font-weight: 700; color: #8B3A2A;">${w.department}</div>
          <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">${w.role}</div>
        </td>
        <td style="padding: 12px; text-align: right; font-weight: 800; color: #1f2937; font-size: 13px;">
          ₹${w.ratePerDay}
        </td>
      </tr>
    `;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Workforce Dispatch Notification</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; color: #1f2937;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f3f4f6; padding: 20px 0;">
        <tr>
          <td align="center">
            <!-- Main Card Container -->
            <table border="0" cellpadding="0" cellspacing="0" width="600" style="background-color: #ffffff; border: 3px solid #1f2937; box-shadow: 6px 6px 0px #1f2937; border-radius: 4px; overflow: hidden;">
              <!-- Header Section -->
              <tr>
                <td style="background-color: #8B3A2A; padding: 24px 30px; border-bottom: 3px solid #1f2937; text-align: left;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td>
                        <div style="font-size: 28px; font-weight: 900; color: #ffffff; letter-spacing: -0.02em; display: inline-block;">
                          VMS <span style="background-color: #ffffff; color: #8B3A2A; padding: 2px 6px; border: 2px solid #1f2937; margin-left: 6px; box-shadow: 2px 2px 0px #1f2937; font-size: 18px; vertical-align: middle;">DISPATCH</span>
                        </div>
                        <div style="font-size: 11px; font-weight: 600; color: #fca5a5; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 6px;">
                          Vendor Management System Operations
                        </div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Content Area -->
              <tr>
                <td style="padding: 30px; background-color: #ffffff; text-align: left;">
                  <!-- Greeting -->
                  <h2 style="font-size: 20px; font-weight: 900; margin-top: 0; color: #1f2937; border-bottom: 2px solid #1f2937; padding-bottom: 10px; display: inline-block;">
                    Hello ${agency.contactPerson || 'Vendor Partner'},
                  </h2>
                  <p style="font-size: 14px; line-height: 1.6; color: #4b5563; margin-bottom: 24px;">
                    We are pleased to inform you that workers from <strong>${agency.agencyName}</strong> have been scheduled and assigned for active duty. Please review the service breakdown and specific duty roster assignments detailed below.
                  </p>

                  <!-- Statistics Overview Section -->
                  <div style="margin-bottom: 30px;">
                    <h3 style="font-size: 14px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.05em; color: #1f2937; margin-bottom: 12px; margin-top: 0;">
                      📊 Deployment Summary
                    </h3>
                    <div style="margin-bottom: 16px;">
                      ${serviceCardsHtml}
                    </div>
                    <div style="background-color: #1f2937; color: #ffffff; padding: 12px 16px; border-radius: 4px; font-weight: bold; font-size: 15px; display: inline-block; box-shadow: 2px 2px 0px #1f2937; border: 2px solid #1f2937;">
                      Total Workforce Deployed: ${totalWorkers} Worker(s)
                    </div>
                  </div>

                  <!-- Allocation Details Table -->
                  <div style="margin-bottom: 30px;">
                    <h3 style="font-size: 14px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.05em; color: #1f2937; margin-bottom: 12px;">
                      📋 Roster Assignments Ledger
                    </h3>
                    <div style="overflow-x: auto; border: 3px solid #1f2937; border-radius: 4px; box-shadow: 4px 4px 0px #1f2937;">
                      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse; min-width: 100%;">
                        <thead>
                          <tr style="background-color: #f3f4f6; border-bottom: 3px solid #1f2937;">
                            <th align="left" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563; border-right: 2px solid #1f2937;">Date</th>
                            <th align="left" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563; border-right: 2px solid #1f2937;">Zone</th>
                            <th align="left" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563; border-right: 2px solid #1f2937;">Worker</th>
                            <th align="left" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563; border-right: 2px solid #1f2937;">Aadhaar Number</th>
                            <th align="left" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563; border-right: 2px solid #1f2937;">Service / Role</th>
                            <th align="right" style="padding: 12px; font-size: 11px; font-weight: 900; text-transform: uppercase; color: #4b5563;">Daily Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${rosterRowsHtml}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <!-- Actions / Guidelines -->
                  <div style="background-color: #fffbeb; border: 2px solid #d97706; padding: 16px; border-radius: 4px; margin-bottom: 24px; box-shadow: 2px 2px 0px #d97706;">
                    <div style="font-weight: 900; color: #b45309; font-size: 13px; text-transform: uppercase; margin-bottom: 6px;">
                      ⚠️ Operational Instructions
                    </div>
                    <ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; color: #78350f;">
                      <li>Ensure all personnel are dispatched to their designated <strong>Zones</strong> on time.</li>
                      <li>Workers must carry valid identification matching their registered Aadhaar profiles.</li>
                      <li>Standard uniforms and safety gear are mandatory for all shifts.</li>
                    </ul>
                  </div>

                  <p style="font-size: 13px; line-height: 1.5; color: #6b7280; margin: 0;">
                    For modifications, cancellations, or support, please log in to your <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}" style="color: #8B3A2A; font-weight: bold; text-decoration: underline;">Agency Portal</a> or contact VMS Support.
                  </p>
                </td>
              </tr>

              <!-- Footer Block -->
              <tr>
                <td style="background-color: #f9fafb; border-top: 3px solid #1f2937; padding: 24px 30px; text-align: center;">
                  <p style="font-size: 12px; color: #9ca3af; margin: 0 0 8px 0;">
                    This is an automated notification from the Vendor Management System (VMS) Operations Console.
                  </p>
                  <p style="font-size: 12px; font-weight: bold; color: #4b5563; margin: 0;">
                    © 2026 VMS Operations Console. All rights reserved.
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
};

/**
 * Main dispatcher routine for parsing allocations and invoking Resend SDK.
 */
const sendAllocationEmails = async (allocations) => {
  if (!allocations || Object.keys(allocations).length === 0) {
    console.log('[Resend Email] No allocations to notify.');
    return [];
  }

  // 1. Gather all unique worker IDs from the allocations payload
  const workerIds = [];
  Object.keys(allocations).forEach(dateZoneKey => {
    const slotMap = allocations[dateZoneKey] || {};
    Object.keys(slotMap).forEach(slotKey => {
      const worker = slotMap[slotKey];
      if (worker && worker.id) {
        workerIds.push(worker.id);
      }
    });
  });

  if (workerIds.length === 0) {
    console.log('[Resend Email] No assigned worker IDs found in the payload.');
    return [];
  }

  try {
    // 2. Query all assigned workers along with their agency info from DB
    const workersWithAgencies = await prisma.worker.findMany({
      where: { id: { in: workerIds } },
      include: { agency: true }
    });

    // 3. Create a map of worker details for quick lookup
    const workerMap = {};
    workersWithAgencies.forEach(w => {
      workerMap[w.id] = w;
    });

    // 4. Group allocations by agencyId
    const agencyAllocations = {}; // agencyId -> { agency, list: [ { date, zone, slotKey, worker } ] }

    Object.keys(allocations).forEach(dateZoneKey => {
      const [date, zone] = dateZoneKey.split('_');
      const slotMap = allocations[dateZoneKey] || {};

      Object.keys(slotMap).forEach(slotKey => {
        const wObj = slotMap[slotKey];
        if (wObj && wObj.id) {
          const dbWorker = workerMap[wObj.id];
          if (dbWorker && dbWorker.agency) {
            const agency = dbWorker.agency;
            if (!agencyAllocations[agency.id]) {
              agencyAllocations[agency.id] = {
                agency,
                list: []
              };
            }
            agencyAllocations[agency.id].list.push({
              date,
              zone,
              slotKey,
              worker: dbWorker
            });
          }
        }
      });
    });

    // 5. Initialize Resend
    const apiKey = process.env.RESEND_API_KEY;
    const isMock = !apiKey || apiKey === 're_your_api_key_here' || apiKey === 're_dummy_key';
    
    let resendClient = null;
    if (!isMock) {
      resendClient = new Resend(apiKey);
    }

    const emailResults = [];

    // 6. Loop through each agency and prepare email
    for (const agencyId of Object.keys(agencyAllocations)) {
      const { agency, list } = agencyAllocations[agencyId];
      
      const totalWorkers = list.length;
      
      // Service segregation: count by department
      const departmentCounts = {};
      
      list.forEach(item => {
        const dept = item.worker.department || 'GENERAL';
        departmentCounts[dept] = (departmentCounts[dept] || 0) + 1;
      });

      // Sort assignments list by Date then Zone then Worker Name for elegant presentation
      list.sort((a, b) => {
        const dateComp = a.date.localeCompare(b.date);
        if (dateComp !== 0) return dateComp;
        const zoneComp = a.zone.localeCompare(b.zone);
        if (zoneComp !== 0) return zoneComp;
        return a.worker.name.localeCompare(b.worker.name);
      });

      // Prepare HTML content
      const emailHtml = generateCreativeEmailHtml(agency, totalWorkers, departmentCounts, list);
      const emailSubject = `🚨 VMS Workforce Dispatch Notification: ${totalWorkers} Workers Assigned`;

      console.log(`[Resend Email] Preparing email dispatch for ${agency.agencyName} (${agency.email})`);

      if (isMock) {
        console.log(`\n=================== MOCK EMAIL DISPATCH ===================`);
        console.log(`To: ${agency.email} (${agency.contactPerson})`);
        console.log(`Subject: ${emailSubject}`);
        console.log(`Reason: RESEND_API_KEY is not configured or is placeholder.`);
        console.log(`------------------- EMAIL HTML START -------------------`);
        console.log(emailHtml);
        console.log(`------------------- EMAIL HTML END ---------------------`);
        console.log(`===========================================================\n`);
        
        emailResults.push({
          agencyName: agency.agencyName,
          email: agency.email,
          status: 'skipped',
          reason: 'Mock sandboxed send (no API Key configured)'
        });
      } else {
        try {
          // Send using Resend SDK
          // Resend requires verified domains, so we default to onboarding@resend.dev or similar for test mode
          const sendResult = await resendClient.emails.send({
            from: 'VMS Dispatch <onboarding@resend.dev>',
            to: agency.email,
            subject: emailSubject,
            html: emailHtml
          });

          console.log(`[Resend Email] Successful email delivery to ${agency.agencyName}:`, sendResult);
          emailResults.push({
            agencyName: agency.agencyName,
            email: agency.email,
            status: 'success',
            id: sendResult.id
          });
        } catch (sendError) {
          console.error(`[Resend Email] SDK failed to deliver email to ${agency.agencyName}:`, sendError);
          emailResults.push({
            agencyName: agency.agencyName,
            email: agency.email,
            status: 'failed',
            error: sendError.message || sendError
          });
        }
      }
    }

    return emailResults;
  } catch (error) {
    console.error('[Resend Email] Dispatch routine encountered an error:', error);
    throw error;
  }
};

// @desc    Get all registered workers from database
// @route   GET /api/admin/workers
// @access  Admin
const getAllWorkers = async (req, res) => {
  try {
    const workers = await prisma.worker.findMany({
      include: {
        agency: {
          select: {
            agencyName: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const mappedWorkers = workers.map(w => ({
      id: w.id,
      name: w.name,
      gender: w.gender || 'Male',
      dept: w.department,
      agency: w.agency?.agencyName || 'Independent Agency',
      ratePerDay: w.ratePerDay,
      role: w.role,
      dob: w.dob,
      aadharNumber: w.aadharNumber
    }));

    res.json(mappedWorkers);
  } catch (error) {
    console.error('Get all database workers error:', error);
    res.status(500).json({ message: 'Server error fetching database workers.' });
  }
};

// @desc    Get requirements for a date + zone
// @route   GET /api/admin/requirements?date=&zone=
// @access  Admin
const getRequirements = async (req, res) => {
  const { date, zone } = req.query;
  try {
    const where = {};
    if (date) where.date = date;
    if (zone) where.zone = zone;

    const reqs = await prisma.requirement.findMany({ where, orderBy: { department: 'asc' } });
    res.json(reqs);
  } catch (error) {
    console.error('Get requirements error:', error);
    res.status(500).json({ message: 'Server error fetching requirements' });
  }
};

// @desc    Save (upsert) requirements for a date + zone
// @route   POST /api/admin/requirements
// @access  Admin
const saveRequirements = async (req, res) => {
  const { date, zone, departments } = req.body;
  // departments: [{ department: 'SECURITY', slots: 10 }, ...]

  if (!date || !zone || !Array.isArray(departments)) {
    return res.status(400).json({ message: 'date, zone, and departments[] are required' });
  }

  try {
    const upserts = departments.map(({ department, slots }) =>
      prisma.requirement.upsert({
        where: { date_zone_department: { date, zone, department } },
        update: { slots: Number(slots) },
        create: { date, zone, department, slots: Number(slots) },
      })
    );

    const results = await prisma.$transaction(upserts);
    res.json({ message: 'Requirements saved successfully', data: results });
  } catch (error) {
    console.error('Save requirements error:', error);
    res.status(500).json({ message: 'Server error saving requirements' });
  }
};

module.exports = { signupAdmin, loginAdmin, getAllAgencies, getAllQuotations, getAllAllocations, saveAllocations, getAllWorkers, getRequirements, saveRequirements };

