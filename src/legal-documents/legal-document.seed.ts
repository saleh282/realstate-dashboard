import { LegalDocumentSectionContent, LegalDocumentType } from './legal-document.types';

/**
 * Version 1 of the terms and the privacy policy, inserted by migration
 * 039-legal-documents. This is a first draft written from what the system
 * actually collects and does; it has not been reviewed by a lawyer.
 *
 * Every `[[...]]` token is a fact only the company can supply. Replace them
 * (through an admin draft + publish) before the documents are relied on.
 */
export type LegalDocumentSeed = {
  type: LegalDocumentType;
  titleAr: string;
  titleEn: string;
  sections: LegalDocumentSectionContent[];
};

export const LEGAL_SEED_PLACEHOLDERS = [
  '[[COMPANY_LEGAL_NAME]]',
  '[[COMPANY_ADDRESS]]',
  '[[CONTACT_EMAIL]]',
  '[[GOVERNING_LAW]]',
  '[[COMPETENT_COURTS]]',
] as const;

const TERMS_SECTIONS: LegalDocumentSectionContent[] = [
  {
    headingAr: '1. مقدمة وقبول الشروط',
    headingEn: '1. Introduction and acceptance',
    bodyAr:
      'منصة «ASL أصل» («المنصة») تطبيق لعرض العقارات والبحث عنها، تديره [[COMPANY_LEGAL_NAME]] («نحن»).\n\nبإنشائك حساباً أو باستخدامك المنصة فإنك توافق على هذه الشروط والأحكام وعلى سياسة الخصوصية. إذا لم توافق عليها فلا تستخدم المنصة.',
    bodyEn:
      'ASL ("the Platform") is an application for listing and searching for real estate, operated by [[COMPANY_LEGAL_NAME]] ("we", "us").\n\nBy creating an account or using the Platform you agree to these Terms and Conditions and to the Privacy Policy. If you do not agree, do not use the Platform.',
  },
  {
    headingAr: '2. تعريفات',
    headingEn: '2. Definitions',
    bodyAr:
      '• «المستخدم»: كل من يتصفح المنصة أو ينشئ حساباً عليها.\n• «المُعلِن»: المستخدم الذي ينشر إعلاناً عقارياً، سواء كان مالكاً أو وسيطاً.\n• «الوسيط»: مستخدم وافقنا على طلبه للعمل كوسيط عقاري على المنصة.\n• «الإعلان»: بيانات العقار وصوره وموقعه وسعره كما ينشرها المُعلِن.',
    bodyEn:
      '• "User": anyone who browses the Platform or creates an account on it.\n• "Advertiser": a User who publishes a property listing, whether as an owner or as a broker.\n• "Broker": a User whose application to act as a real-estate broker on the Platform we have approved.\n• "Listing": the property details, photos, location and price as published by the Advertiser.',
  },
  {
    headingAr: '3. الحساب والأهلية',
    headingEn: '3. Account and eligibility',
    bodyAr:
      'يجب ألا يقل عمرك عن 18 عاماً وأن تكون كامل الأهلية القانونية لإنشاء حساب.\n\nتلتزم بتقديم بيانات صحيحة (الاسم، البريد الإلكتروني، رقم الهاتف) وتحديثها عند تغيرها. يتم تأكيد الحساب برمز يُرسل إلى بريدك الإلكتروني.\n\nأنت مسؤول عن سرية كلمة المرور وعن كل ما يتم من خلال حسابك. أبلغنا فوراً إذا اشتبهت في استخدام غير مصرح به.\n\nيمكن تصفح العقارات كزائر دون حساب، لكن بعض الخصائص تتطلب تسجيل الدخول.',
    bodyEn:
      'You must be at least 18 years old and have full legal capacity to create an account.\n\nYou agree to provide accurate details (name, email address, phone number) and to keep them up to date. The account is confirmed with a code sent to your email address.\n\nYou are responsible for keeping your password confidential and for everything done through your account. Tell us immediately if you suspect unauthorised use.\n\nProperties can be browsed as a guest without an account, but some features require signing in.',
  },
  {
    headingAr: '4. التحقق من الهوية',
    headingEn: '4. Identity verification',
    bodyAr:
      'قد نطلب منك توثيق هويتك برفع صورة بطاقة الهوية وصورة شخصية قبل السماح ببعض الخصائص مثل نشر الإعلانات. نراجع هذه المستندات وقد نقبلها أو نرفضها أو نطلب إعادة إرسالها.\n\nتقديم مستندات مزورة أو تخص شخصاً آخر يعد مخالفة جسيمة تجيز إيقاف الحساب.',
    bodyEn:
      'We may ask you to verify your identity by uploading a photo of your ID card and a selfie before certain features, such as publishing listings, are made available. We review these documents and may accept them, reject them or ask you to resubmit.\n\nSubmitting forged documents, or documents that belong to someone else, is a serious breach and may lead to suspension of the account.',
  },
  {
    headingAr: '5. الإعلانات العقارية',
    headingEn: '5. Property listings',
    bodyAr:
      'عند نشر إعلان فإنك تقر بأن:\n• لك الحق القانوني في عرض العقار، بصفتك مالكاً أو مفوضاً من المالك.\n• جميع البيانات والصور والموقع والسعر صحيحة وغير مضللة وتخص العقار نفسه.\n• الإعلان لا يخالف القوانين المعمول بها ولا حقوق الغير.\n\nتخضع الإعلانات لمراجعتنا قبل النشر. يحق لنا رفض أي إعلان أو طلب تعديله أو إخفاؤه أو حذفه إذا خالف هذه الشروط أو وردت بشأنه شكوى جدية.\n\nتلتزم بتحديث الإعلان أو إزالته عند بيع العقار أو تأجيره أو تغير بياناته.',
    bodyEn:
      'By publishing a Listing you confirm that:\n• you have the legal right to offer the property, as its owner or with the owner\'s authorisation;\n• all details, photos, location and price are accurate, not misleading and relate to that property;\n• the Listing does not breach applicable law or the rights of others.\n\nListings are reviewed by us before they are published. We may reject a Listing, ask for changes, hide it or remove it if it breaches these Terms or is the subject of a credible complaint.\n\nYou agree to update or remove the Listing when the property is sold or rented or its details change.',
  },
  {
    headingAr: '6. الوسطاء العقاريون',
    headingEn: '6. Real-estate brokers',
    bodyAr:
      'يمكن للمستخدم التقدم بطلب للعمل كوسيط على المنصة، ونحتفظ بحق قبول الطلب أو رفضه أو إلغاء الصفة لاحقاً.\n\nيلتزم الوسيط بالحصول على أي تراخيص يتطلبها القانون لمزاولة نشاطه وبالإفصاح عن صفته للمتعاملين معه، وهو وحده المسؤول عن التزاماته تجاه عملائه.',
    bodyEn:
      'A User may apply to act as a Broker on the Platform. We may accept or reject the application, and may withdraw Broker status later.\n\nA Broker must hold any licence the law requires for that activity, must disclose that they act as a broker to the people they deal with, and is solely responsible for their obligations to their own clients.',
  },
  {
    headingAr: '7. دور المنصة',
    headingEn: '7. The role of the Platform',
    bodyAr:
      'المنصة وسيلة عرض وتواصل بين المُعلِنين والباحثين عن عقارات. لسنا طرفاً في أي اتفاق بيع أو إيجار يتم بين المستخدمين، ولا نملك العقارات المعروضة ولا نمثل أياً من الطرفين.\n\nمراجعتنا للإعلانات وتوثيق الهوية لا يعدّان ضماناً لملكية العقار أو لحالته أو لصحة ما ورد في الإعلان. يجب عليك معاينة العقار والتحقق من مستنداته والاستعانة بمختص قانوني قبل إبرام أي تعاقد أو سداد أي مبلغ.',
    bodyEn:
      'The Platform is a venue for presenting properties and connecting Advertisers with people looking for property. We are not a party to any sale or rental agreement between Users, we do not own the listed properties, and we do not represent either side.\n\nOur review of Listings and our identity checks are not a guarantee of ownership, of the condition of a property, or of the accuracy of a Listing. You should inspect the property, verify its documents and take legal advice before entering into any contract or paying any money.',
  },
  {
    headingAr: '8. الخدمات المدفوعة والمدفوعات',
    headingEn: '8. Paid services and payments',
    bodyAr:
      'قد نقدم خدمات مدفوعة مثل باقات التسويق المُدار للإعلانات. تُعرض قيمة كل خدمة وما تشمله قبل تأكيد الطلب، وتُسدد بالجنيه المصري عبر مزود خدمة دفع خارجي.\n\nتُحدَّد شروط الاسترداد لكل خدمة عند طلبها. ما لم يُذكر خلاف ذلك أو يوجب القانون غيره، لا تُسترد قيمة الخدمة بعد البدء في تنفيذها.',
    bodyEn:
      'We may offer paid services, such as managed marketing packages for Listings. The price of each service and what it includes are shown before you confirm the order, and are paid in Egyptian pounds through a third-party payment provider.\n\nRefund terms for each service are stated when you order it. Unless stated otherwise or required by law, a service is not refundable once its delivery has started.',
  },
  {
    headingAr: '9. الاستخدام المحظور',
    headingEn: '9. Prohibited use',
    bodyAr:
      'يُحظر عليك:\n• نشر إعلانات وهمية أو مكررة أو مضللة، أو لعقار لا تملك حق عرضه.\n• انتحال شخصية الغير أو تقديم بيانات أو مستندات غير صحيحة.\n• استخدام المنصة في الاحتيال أو غسل الأموال أو أي نشاط مخالف للقانون.\n• نشر محتوى مسيء أو تمييزي أو ينتهك حقوق الغير.\n• جمع بيانات المستخدمين أو استخراج محتوى المنصة بوسائل آلية دون إذن كتابي.\n• محاولة اختراق المنصة أو تعطيلها أو تجاوز وسائل الحماية فيها.\n• إنشاء أكثر من حساب للتحايل على إيقاف أو قيد سابق.',
    bodyEn:
      'You must not:\n• publish fake, duplicate or misleading Listings, or a Listing for a property you have no right to offer;\n• impersonate anyone or provide false details or documents;\n• use the Platform for fraud, money laundering or any unlawful activity;\n• publish content that is offensive, discriminatory or infringes the rights of others;\n• collect Users\' data or extract Platform content by automated means without written permission;\n• attempt to breach or disrupt the Platform or bypass its security measures;\n• create more than one account to get around an earlier suspension or restriction.',
  },
  {
    headingAr: '10. المحتوى والملكية الفكرية',
    headingEn: '10. Content and intellectual property',
    bodyAr:
      'تحتفظ بملكية ما تنشره من نصوص وصور. بنشرك المحتوى تمنحنا ترخيصاً غير حصري وبلا مقابل لعرضه ونسخه وتعديل حجمه وصيغته داخل المنصة وفي المواد الترويجية للمنصة، طوال مدة بقاء الإعلان ولمدة معقولة بعدها لأغراض الحفظ والامتثال.\n\nاسم المنصة وشعارها وتصميمها وبرمجياتها ملك لنا، ولا يجوز استخدامها دون إذن كتابي.',
    bodyEn:
      'You keep ownership of the text and photos you publish. By publishing content you grant us a non-exclusive, royalty-free licence to display, copy, resize and reformat it within the Platform and in promotional material for the Platform, for as long as the Listing remains and for a reasonable period afterwards for record-keeping and compliance.\n\nThe Platform\'s name, logo, design and software belong to us and may not be used without written permission.',
  },
  {
    headingAr: '11. إيقاف الحساب وحذفه',
    headingEn: '11. Suspension and deletion of the account',
    bodyAr:
      'يحق لنا إيقاف الحساب مؤقتاً أو حظره نهائياً أو إزالة أي محتوى إذا خالفت هذه الشروط أو القانون، أو إذا كان ذلك ضرورياً لحماية المستخدمين أو المنصة.\n\nيمكنك طلب حذف حسابك من داخل التطبيق في أي وقت. يبقى الحساب قابلاً للاستعادة لمدة 30 يوماً، وبعدها تُزال بياناتك التعريفية وفق سياسة الخصوصية. قد يتعذر تنفيذ الحذف أو يتأخر إذا وُجدت التزامات قائمة أو تحفظ قانوني على الحساب.',
    bodyEn:
      'We may suspend an account temporarily, ban it permanently or remove any content if you breach these Terms or the law, or where that is necessary to protect Users or the Platform.\n\nYou can request deletion of your account from inside the app at any time. The account can be restored for 30 days; after that your identifying details are removed as described in the Privacy Policy. Deletion may be refused or delayed where there are outstanding obligations or a legal hold on the account.',
  },
  {
    headingAr: '12. إخلاء المسؤولية وحدودها',
    headingEn: '12. Disclaimers and limitation of liability',
    bodyAr:
      'تُقدَّم المنصة «كما هي» و«حسب توافرها». لا نضمن خلوها من الأخطاء أو استمرار عملها دون انقطاع، ولا نضمن دقة الإعلانات التي ينشرها المستخدمون.\n\nفي الحدود التي يسمح بها القانون، لا نتحمل المسؤولية عن الخسائر الناتجة عن تعاملك مع مستخدمين آخرين أو عن اعتمادك على محتوى إعلان، ولا عن الأضرار غير المباشرة أو فوات الكسب. لا يحدّ هذا البند من أي مسؤولية لا يجيز القانون استبعادها.',
    bodyEn:
      'The Platform is provided "as is" and "as available". We do not guarantee that it will be error-free or uninterrupted, and we do not guarantee the accuracy of Listings published by Users.\n\nTo the extent permitted by law, we are not liable for losses arising from your dealings with other Users or from your reliance on the content of a Listing, nor for indirect losses or loss of profit. Nothing in this section limits liability that cannot be excluded by law.',
  },
  {
    headingAr: '13. تعديل الشروط',
    headingEn: '13. Changes to these Terms',
    bodyAr:
      'قد نعدّل هذه الشروط من وقت لآخر. يحمل كل تعديل رقم إصدار وتاريخ نشر جديدين ويظهر داخل التطبيق. استمرارك في استخدام المنصة بعد نشر التعديل يعد قبولاً له، وقد نطلب موافقتك الصريحة على التعديلات الجوهرية.',
    bodyEn:
      'We may change these Terms from time to time. Each change carries a new version number and publication date and is shown in the app. Continuing to use the Platform after a change is published counts as acceptance of it, and we may ask for your explicit agreement to material changes.',
  },
  {
    headingAr: '14. القانون الواجب التطبيق وتسوية النزاعات',
    headingEn: '14. Governing law and disputes',
    bodyAr:
      'تخضع هذه الشروط لـ[[GOVERNING_LAW]]، وتختص [[COMPETENT_COURTS]] بالفصل في أي نزاع ينشأ عنها، بعد محاولة تسويته ودياً.',
    bodyEn:
      'These Terms are governed by [[GOVERNING_LAW]]. Any dispute arising from them that cannot be settled amicably is subject to the jurisdiction of [[COMPETENT_COURTS]].',
  },
  {
    headingAr: '15. التواصل معنا',
    headingEn: '15. Contact us',
    bodyAr:
      '[[COMPANY_LEGAL_NAME]]\nالعنوان: [[COMPANY_ADDRESS]]\nالبريد الإلكتروني: [[CONTACT_EMAIL]]',
    bodyEn:
      '[[COMPANY_LEGAL_NAME]]\nAddress: [[COMPANY_ADDRESS]]\nEmail: [[CONTACT_EMAIL]]',
  },
];

const PRIVACY_SECTIONS: LegalDocumentSectionContent[] = [
  {
    headingAr: '1. من نحن',
    headingEn: '1. Who we are',
    bodyAr:
      'تدير [[COMPANY_LEGAL_NAME]] منصة «ASL أصل»، وهي المسؤولة عن بياناتك الشخصية التي تُعالج عبر المنصة. توضح هذه السياسة ما نجمعه من بيانات، ولماذا، ومع من نشاركه، وما هي حقوقك.',
    bodyEn:
      '[[COMPANY_LEGAL_NAME]] operates the ASL platform and is responsible for the personal data processed through it. This policy explains what data we collect, why, who we share it with, and what your rights are.',
  },
  {
    headingAr: '2. البيانات التي نجمعها',
    headingEn: '2. The data we collect',
    bodyAr:
      'بيانات تقدمها أنت:\n• بيانات الحساب: الاسم الكامل، البريد الإلكتروني، رقم الهاتف، وكلمة المرور (تُحفظ مشفرة ولا يمكننا قراءتها).\n• بيانات التحقق من الهوية: صورة وجه وظهر بطاقة الهوية وصورة شخصية، ونتيجة المراجعة.\n• بيانات الإعلانات: وصف العقار وصوره ومستنداته وسعره وموقعه وعنوانه.\n• طلبات الوساطة العقارية وطلبات التسويق المُدار وما تتضمنه من بيانات.\n\nبيانات تُجمع تلقائياً:\n• عنوان بروتوكول الإنترنت (IP) واسم الجهاز ونوع المتصفح أو التطبيق عند تسجيل الدخول.\n• سجل العمليات الأمنية على الحساب، مثل تسجيل الدخول والخروج وتغيير كلمة المرور.\n• موقعك الجغرافي التقريبي أو الدقيق، فقط إذا منحت التطبيق إذن الموقع.\n• إصدارات الشروط والأحكام وسياسة الخصوصية التي وافقت عليها وتاريخ الموافقة.\n\nبيانات المدفوعات:\n• عند شراء خدمة مدفوعة نحتفظ بسجل العملية (المبلغ، الحالة، الرقم المرجعي). تُدخل بيانات البطاقة لدى مزود خدمة الدفع ولا نحتفظ بأرقام البطاقات كاملة.',
    bodyEn:
      'Data you give us:\n• Account details: full name, email address, phone number and password (stored hashed; we cannot read it).\n• Identity verification data: photos of the front and back of your ID card, a selfie, and the outcome of the review.\n• Listing data: the description, photos, documents, price, location and address of the property.\n• Broker applications and managed-marketing requests, and the details they contain.\n\nData collected automatically:\n• IP address, device name and browser or app type when you sign in.\n• A security log of actions on the account, such as sign-in, sign-out and password changes.\n• Your approximate or precise location, only if you grant the app location permission.\n• The versions of the Terms and of this Privacy Policy you accepted, and when.\n\nPayment data:\n• When you buy a paid service we keep a record of the transaction (amount, status, reference number). Card details are entered with the payment provider; we do not keep full card numbers.',
  },
  {
    headingAr: '3. كيف نستخدم بياناتك',
    headingEn: '3. How we use your data',
    bodyAr:
      '• إنشاء حسابك وتأكيده بالبريد الإلكتروني وتسجيل دخولك وحماية الحساب.\n• التحقق من هويتك ومن صفة الوسيط للحد من الاحتيال.\n• مراجعة إعلاناتك ونشرها وعرضها للباحثين عن عقارات.\n• عرض العقارات على الخريطة وتحويل العناوين إلى مواقع جغرافية.\n• تنفيذ الخدمات المدفوعة ومعالجة مدفوعاتها وتسويتها.\n• إرسال رموز التحقق والإشعارات المتعلقة بحسابك وإعلاناتك وطلباتك.\n• الرد على استفساراتك وشكاواك.\n• كشف إساءة الاستخدام ومنعها، وحفظ سجلات المراجعة، والوفاء بالتزاماتنا القانونية.\n\nرقم الهاتف وسيلة تواصل فقط؛ التحقق من الحساب يتم بالبريد الإلكتروني.',
    bodyEn:
      '• To create your account, confirm it by email, sign you in and protect the account.\n• To verify your identity and Broker status in order to reduce fraud.\n• To review and publish your Listings and show them to people looking for property.\n• To show properties on a map and convert addresses into locations.\n• To deliver paid services and process and reconcile their payments.\n• To send verification codes and notifications about your account, Listings and requests.\n• To respond to your questions and complaints.\n• To detect and prevent misuse, keep audit records and meet our legal obligations.\n\nYour phone number is a contact detail only; account verification is done by email.',
  },
  {
    headingAr: '4. الأساس الذي نعتمد عليه',
    headingEn: '4. The basis for processing',
    bodyAr:
      'نعالج بياناتك بناءً على موافقتك عند إنشاء الحساب، ولتنفيذ هذه الشروط وتقديم الخدمة التي طلبتها، وللوفاء بالالتزامات القانونية، ولمصلحتنا المشروعة في حماية المنصة ومستخدميها من الاحتيال.\n\nيمكنك سحب موافقتك في أي وقت بحذف حسابك، دون أن يؤثر ذلك على ما تم من معالجة قبل السحب.',
    bodyEn:
      'We process your data on the basis of the consent you give when creating the account, to perform these terms and deliver the service you asked for, to comply with legal obligations, and for our legitimate interest in protecting the Platform and its Users from fraud.\n\nYou can withdraw consent at any time by deleting your account; this does not affect processing carried out before the withdrawal.',
  },
  {
    headingAr: '5. ما يظهر للآخرين',
    headingEn: '5. What other people can see',
    bodyAr:
      'الإعلان المنشور وما يتضمنه من وصف وصور وسعر وموقع يظهر لجميع مستخدمي المنصة وزوارها، ومعه اسم المُعلِن وصفته وحالة توثيقه.\n\nصور بطاقة الهوية والصورة الشخصية لا تظهر لأي مستخدم، ويطلع عليها فقط الموظفون المخولون بمراجعة التوثيق.',
    bodyEn:
      'A published Listing, with its description, photos, price and location, is visible to all Users and visitors of the Platform, together with the Advertiser\'s name, role and verification status.\n\nYour ID photos and selfie are never shown to other Users; only staff authorised to review verification can see them.',
  },
  {
    headingAr: '6. مع من نشارك بياناتك',
    headingEn: '6. Who we share your data with',
    bodyAr:
      'لا نبيع بياناتك الشخصية. نشاركها فقط مع:\n• مزودي خدمات يعملون لحسابنا: الاستضافة وقواعد البيانات، تخزين الصور والمستندات، خدمات الخرائط وتحديد المواقع، إرسال البريد الإلكتروني، ومعالجة المدفوعات. يحصل كل منهم على ما يلزم لأداء خدمته فقط.\n• الجهات الرسمية والقضائية عندما يوجب القانون ذلك أو لحماية حقوقنا أو حقوق المستخدمين.\n• خلف قانوني في حالة اندماج أو استحواذ أو نقل للنشاط، مع الالتزام بهذه السياسة.\n\nقد توجد خوادم بعض هؤلاء المزودين خارج بلدك، وفي هذه الحالة تُنقل البيانات وفق الضوابط التي يقررها القانون.',
    bodyEn:
      'We do not sell your personal data. We share it only with:\n• service providers acting on our behalf: hosting and databases, storage of photos and documents, maps and location services, email delivery and payment processing. Each receives only what it needs to provide its service;\n• public and judicial authorities where the law requires it, or to protect our rights or those of Users;\n• a legal successor in the event of a merger, acquisition or transfer of the business, subject to this policy.\n\nSome of these providers may have servers outside your country; in that case data is transferred under the safeguards required by law.',
  },
  {
    headingAr: '7. مدة الاحتفاظ وحذف الحساب',
    headingEn: '7. Retention and account deletion',
    bodyAr:
      'نحتفظ ببياناتك طوال مدة وجود حسابك.\n\nعند طلب حذف الحساب يُعطَّل الحساب ويبقى قابلاً للاستعادة لمدة 30 يوماً. بعد انتهائها تُزال بياناتك التعريفية (الاسم، البريد الإلكتروني، رقم الهاتف، الصورة الشخصية، العنوان) ويصبح الحساب مجهول الهوية.\n\nقد نحتفظ بعد ذلك بسجلات محدودة لا تكشف هويتك مباشرة، مثل سجلات المدفوعات وسجلات المراجعة ومستندات التحقق، للمدة التي يوجبها القانون أو تقتضيها تسوية النزاعات ومنع الاحتيال. إذا وُجد تحفظ قانوني على الحساب يُؤجَّل الحذف حتى رفعه.',
    bodyEn:
      'We keep your data for as long as your account exists.\n\nWhen you request deletion, the account is disabled and can be restored for 30 days. After that your identifying details (name, email address, phone number, profile photo, address) are removed and the account becomes anonymous.\n\nAfter that we may keep limited records that do not directly identify you, such as payment records, audit logs and verification evidence, for as long as the law requires or as needed to resolve disputes and prevent fraud. If the account is under a legal hold, deletion is postponed until the hold is lifted.',
  },
  {
    headingAr: '8. حماية البيانات',
    headingEn: '8. Security',
    bodyAr:
      'نطبق تدابير تقنية وتنظيمية لحماية بياناتك، منها تشفير الاتصال، وحفظ كلمات المرور مشفرة، وقصر الاطلاع على مستندات الهوية على الموظفين المخولين، وتسجيل العمليات الحساسة، وقفل الحساب مؤقتاً بعد تكرار محاولات الدخول الخاطئة.\n\nلا توجد وسيلة حماية كاملة، لذا لا يمكننا ضمان الأمان المطلق. إذا وقع اختراق يؤثر على بياناتك فسنخطرك ونخطر الجهات المختصة وفق ما يوجبه القانون.',
    bodyEn:
      'We apply technical and organisational measures to protect your data, including encrypted connections, hashed passwords, restricting access to identity documents to authorised staff, logging sensitive actions, and temporarily locking an account after repeated failed sign-in attempts.\n\nNo security measure is perfect, so we cannot guarantee absolute security. If a breach affects your data we will notify you and the competent authorities as the law requires.',
  },
  {
    headingAr: '9. حقوقك',
    headingEn: '9. Your rights',
    bodyAr:
      'وفق القانون المعمول به، يحق لك:\n• الاطلاع على بياناتك الشخصية والحصول على نسخة منها.\n• تصحيح البيانات غير الدقيقة؛ ويمكنك تعديل اسمك من داخل التطبيق.\n• طلب حذف حسابك وبياناتك.\n• الاعتراض على بعض أوجه المعالجة أو طلب تقييدها.\n• سحب موافقتك.\n• تقديم شكوى إلى الجهة المختصة بحماية البيانات.\n\nلممارسة أي من هذه الحقوق راسلنا على [[CONTACT_EMAIL]]. قد نطلب ما يثبت هويتك قبل تنفيذ الطلب.',
    bodyEn:
      'Under applicable law you have the right to:\n• access your personal data and obtain a copy of it;\n• have inaccurate data corrected; you can edit your name inside the app;\n• ask for your account and data to be deleted;\n• object to, or ask us to restrict, certain processing;\n• withdraw your consent;\n• complain to the competent data-protection authority.\n\nTo exercise any of these rights, write to us at [[CONTACT_EMAIL]]. We may ask for proof of identity before acting on a request.',
  },
  {
    headingAr: '10. أذونات الجهاز',
    headingEn: '10. Device permissions',
    bodyAr:
      '• الموقع: لتحديد موقع العقار على الخريطة وعرض موقعك عليها. اختياري ويمكن إيقافه من إعدادات الجهاز.\n• الكاميرا والصور والملفات: لرفع صور العقارات ومستنداتها وصور التحقق من الهوية. نصل فقط إلى ما تختاره أنت.',
    bodyEn:
      '• Location: to place a property on the map and to show your position on it. It is optional and can be turned off in the device settings.\n• Camera, photos and files: to upload property photos and documents and identity verification photos. We only access what you choose.',
  },
  {
    headingAr: '11. الأطفال',
    headingEn: '11. Children',
    bodyAr:
      'المنصة غير موجهة لمن هم دون 18 عاماً ولا نجمع بياناتهم عن علم. إذا علمنا بوجود حساب لقاصر فسنحذفه.',
    bodyEn:
      'The Platform is not intended for anyone under 18 and we do not knowingly collect their data. If we learn that an account belongs to a minor we will delete it.',
  },
  {
    headingAr: '12. تعديل هذه السياسة',
    headingEn: '12. Changes to this policy',
    bodyAr:
      'قد نحدّث هذه السياسة. يحمل كل تحديث رقم إصدار وتاريخ نشر جديدين ويظهر داخل التطبيق، وقد نطلب موافقتك على التغييرات الجوهرية.',
    bodyEn:
      'We may update this policy. Each update carries a new version number and publication date and is shown in the app, and we may ask for your agreement to material changes.',
  },
  {
    headingAr: '13. التواصل معنا',
    headingEn: '13. Contact us',
    bodyAr:
      'لأي سؤال عن هذه السياسة أو عن بياناتك:\n[[COMPANY_LEGAL_NAME]]\nالعنوان: [[COMPANY_ADDRESS]]\nالبريد الإلكتروني: [[CONTACT_EMAIL]]',
    bodyEn:
      'For any question about this policy or your data:\n[[COMPANY_LEGAL_NAME]]\nAddress: [[COMPANY_ADDRESS]]\nEmail: [[CONTACT_EMAIL]]',
  },
];

export const LEGAL_DOCUMENT_SEED: readonly LegalDocumentSeed[] = [
  {
    type: LegalDocumentType.TERMS,
    titleAr: 'الشروط والأحكام',
    titleEn: 'Terms and Conditions',
    sections: TERMS_SECTIONS,
  },
  {
    type: LegalDocumentType.PRIVACY,
    titleAr: 'سياسة الخصوصية',
    titleEn: 'Privacy Policy',
    sections: PRIVACY_SECTIONS,
  },
];
