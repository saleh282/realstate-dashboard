export const GOVERNORATE_ICON_OPTIONS = [{ key: 'location', labelAr: 'موقع' }, { key: 'city', labelAr: 'مدينة' }, { key: 'other', labelAr: 'أخرى' }] as const;
export const GOVERNORATE_ICON_KEYS = GOVERNORATE_ICON_OPTIONS.map(i => i.key);
export const DEFAULT_GOVERNORATES = [
  ['cairo', 'القاهرة', 'Cairo', 10],
  ['giza', 'الجيزة', 'Giza', 20],
  ['alexandria', 'الإسكندرية', 'Alexandria', 30],
  ['qalyubia', 'القليوبية', 'Qalyubia', 40],
  ['sharqia', 'الشرقية', 'Sharqia', 50],
  ['dakahlia', 'الدقهلية', 'Dakahlia', 60],
  ['beheira', 'البحيرة', 'Beheira', 70],
  ['kafr_el_sheikh', 'كفر الشيخ', 'Kafr El Sheikh', 80],
  ['gharbia', 'الغربية', 'Gharbia', 90],
  ['monufia', 'المنوفية', 'Monufia', 100],
  ['damietta', 'دمياط', 'Damietta', 110],
  ['port_said', 'بورسعيد', 'Port Said', 120],
  ['ismailia', 'الإسماعيلية', 'Ismailia', 130],
  ['suez', 'السويس', 'Suez', 140],
  ['north_sinai', 'شمال سيناء', 'North Sinai', 150],
  ['south_sinai', 'جنوب سيناء', 'South Sinai', 160],
  ['fayoum', 'الفيوم', 'Fayoum', 170],
  ['beni_suef', 'بني سويف', 'Beni Suef', 180],
  ['minya', 'المنيا', 'Minya', 190],
  ['assiut', 'أسيوط', 'Assiut', 200],
  ['sohag', 'سوهاج', 'Sohag', 210],
  ['qena', 'قنا', 'Qena', 220],
  ['luxor', 'الأقصر', 'Luxor', 230],
  ['aswan', 'أسوان', 'Aswan', 240],
  ['red_sea', 'البحر الأحمر', 'Red Sea', 250],
  ['new_valley', 'الوادي الجديد', 'New Valley', 260],
  ['matrouh', 'مطروح', 'Matrouh', 270],
] as const;

export type GovernorateMapViewport = {
  center: { latitude: number; longitude: number };
  bounds: {
    southWest: { latitude: number; longitude: number };
    northEast: { latitude: number; longitude: number };
  };
};

// Viewports are deliberately presentation-oriented: they frame each
// governorate comfortably on a map and are not administrative boundary data.
export const DEFAULT_GOVERNORATE_MAP_VIEWPORTS: Record<string, GovernorateMapViewport> = {
  cairo: { center: { latitude: 30.0444, longitude: 31.2357 }, bounds: { southWest: { latitude: 29.72, longitude: 30.95 }, northEast: { latitude: 30.36, longitude: 31.76 } } },
  giza: { center: { latitude: 29.987, longitude: 31.2118 }, bounds: { southWest: { latitude: 28.9, longitude: 27.55 }, northEast: { latitude: 30.68, longitude: 31.5 } } },
  alexandria: { center: { latitude: 31.2001, longitude: 29.9187 }, bounds: { southWest: { latitude: 30.72, longitude: 29.32 }, northEast: { latitude: 31.36, longitude: 30.38 } } },
  qalyubia: { center: { latitude: 30.3292, longitude: 31.2168 }, bounds: { southWest: { latitude: 30.08, longitude: 30.97 }, northEast: { latitude: 30.67, longitude: 31.52 } } },
  sharqia: { center: { latitude: 30.7327, longitude: 31.7195 }, bounds: { southWest: { latitude: 30.25, longitude: 31.25 }, northEast: { latitude: 31.18, longitude: 32.32 } } },
  dakahlia: { center: { latitude: 31.0409, longitude: 31.3785 }, bounds: { southWest: { latitude: 30.55, longitude: 31.03 }, northEast: { latitude: 31.55, longitude: 31.98 } } },
  beheira: { center: { latitude: 30.8481, longitude: 30.3436 }, bounds: { southWest: { latitude: 30.12, longitude: 29.48 }, northEast: { latitude: 31.5, longitude: 31.1 } } },
  kafr_el_sheikh: { center: { latitude: 31.1107, longitude: 30.9388 }, bounds: { southWest: { latitude: 30.72, longitude: 30.35 }, northEast: { latitude: 31.6, longitude: 31.32 } } },
  gharbia: { center: { latitude: 30.8754, longitude: 31.0335 }, bounds: { southWest: { latitude: 30.55, longitude: 30.72 }, northEast: { latitude: 31.18, longitude: 31.36 } } },
  monufia: { center: { latitude: 30.5972, longitude: 30.9876 }, bounds: { southWest: { latitude: 30.26, longitude: 30.48 }, northEast: { latitude: 30.86, longitude: 31.32 } } },
  damietta: { center: { latitude: 31.4165, longitude: 31.8133 }, bounds: { southWest: { latitude: 31.05, longitude: 31.48 }, northEast: { latitude: 31.58, longitude: 32.08 } } },
  port_said: { center: { latitude: 31.2653, longitude: 32.3019 }, bounds: { southWest: { latitude: 30.95, longitude: 32.05 }, northEast: { latitude: 31.42, longitude: 32.58 } } },
  ismailia: { center: { latitude: 30.5965, longitude: 32.2715 }, bounds: { southWest: { latitude: 30.18, longitude: 31.82 }, northEast: { latitude: 31.02, longitude: 32.62 } } },
  suez: { center: { latitude: 29.9668, longitude: 32.5498 }, bounds: { southWest: { latitude: 29.45, longitude: 32.05 }, northEast: { latitude: 30.35, longitude: 32.9 } } },
  north_sinai: { center: { latitude: 30.6085, longitude: 33.6176 }, bounds: { southWest: { latitude: 29.95, longitude: 32.55 }, northEast: { latitude: 31.36, longitude: 34.9 } } },
  south_sinai: { center: { latitude: 28.577, longitude: 33.6322 }, bounds: { southWest: { latitude: 27.65, longitude: 32.6 }, northEast: { latitude: 29.95, longitude: 34.95 } } },
  fayoum: { center: { latitude: 29.3084, longitude: 30.8428 }, bounds: { southWest: { latitude: 28.9, longitude: 30.2 }, northEast: { latitude: 29.72, longitude: 31.15 } } },
  beni_suef: { center: { latitude: 29.0661, longitude: 31.0994 }, bounds: { southWest: { latitude: 28.38, longitude: 30.55 }, northEast: { latitude: 29.55, longitude: 31.65 } } },
  minya: { center: { latitude: 28.0871, longitude: 30.7618 }, bounds: { southWest: { latitude: 27.3, longitude: 29.7 }, northEast: { latitude: 28.75, longitude: 32.0 } } },
  assiut: { center: { latitude: 27.1783, longitude: 31.1859 }, bounds: { southWest: { latitude: 26.45, longitude: 30.35 }, northEast: { latitude: 27.8, longitude: 32.05 } } },
  sohag: { center: { latitude: 26.5591, longitude: 31.6957 }, bounds: { southWest: { latitude: 25.95, longitude: 31.0 }, northEast: { latitude: 27.05, longitude: 32.25 } } },
  qena: { center: { latitude: 26.1551, longitude: 32.716 }, bounds: { southWest: { latitude: 25.45, longitude: 31.75 }, northEast: { latitude: 26.8, longitude: 33.5 } } },
  luxor: { center: { latitude: 25.6872, longitude: 32.6396 }, bounds: { southWest: { latitude: 25.25, longitude: 32.25 }, northEast: { latitude: 26.05, longitude: 33.05 } } },
  aswan: { center: { latitude: 24.0889, longitude: 32.8998 }, bounds: { southWest: { latitude: 21.72, longitude: 31.45 }, northEast: { latitude: 25.35, longitude: 34.25 } } },
  red_sea: { center: { latitude: 26.7292, longitude: 33.9365 }, bounds: { southWest: { latitude: 22.0, longitude: 32.45 }, northEast: { latitude: 29.45, longitude: 36.9 } } },
  new_valley: { center: { latitude: 24.5456, longitude: 27.1735 }, bounds: { southWest: { latitude: 21.7, longitude: 24.65 }, northEast: { latitude: 28.8, longitude: 31.5 } } },
  matrouh: { center: { latitude: 29.5696, longitude: 26.4194 }, bounds: { southWest: { latitude: 27.55, longitude: 24.6 }, northEast: { latitude: 31.65, longitude: 29.55 } } },
};

export const DEFAULT_CITIES = [
  ['cairo', 'cairo', 'القاهرة', 'Cairo'], ['cairo', 'new_cairo', 'القاهرة الجديدة', 'New Cairo'], ['cairo', 'nasr_city', 'مدينة نصر', 'Nasr City'], ['cairo', 'heliopolis', 'مصر الجديدة', 'Heliopolis'], ['cairo', 'maadi', 'المعادي', 'Maadi'], ['cairo', 'helwan', 'حلوان', 'Helwan'], ['cairo', 'shorouk', 'الشروق', 'Shorouk'], ['cairo', 'badr', 'بدر', 'Badr'], ['cairo', 'new_administrative_capital', 'العاصمة الإدارية الجديدة', 'New Administrative Capital'],
  ['giza', 'giza', 'الجيزة', 'Giza'], ['giza', 'sixth_of_october', 'مدينة 6 أكتوبر', '6th of October'], ['giza', 'sheikh_zayed', 'الشيخ زايد', 'Sheikh Zayed'], ['giza', 'hawamdeya', 'الحوامدية', 'Hawamdeya'], ['giza', 'badrasheen', 'البدرشين', 'Badrasheen'], ['giza', 'ayat', 'العياط', 'Ayat'], ['giza', 'saf', 'الصف', 'Saf'], ['giza', 'atfih', 'أطفيح', 'Atfih'], ['giza', 'ossim', 'أوسيم', 'Ossim'], ['giza', 'kerdasa', 'كرداسة', 'Kerdasa'],
  ['alexandria', 'alexandria', 'الإسكندرية', 'Alexandria'], ['alexandria', 'borg_el_arab', 'برج العرب', 'Borg El Arab'], ['alexandria', 'new_borg_el_arab', 'برج العرب الجديدة', 'New Borg El Arab'],
  ['qalyubia', 'banha', 'بنها', 'Banha'], ['qalyubia', 'shubra_el_kheima', 'شبرا الخيمة', 'Shubra El Kheima'], ['qalyubia', 'qalyub', 'قليوب', 'Qalyub'], ['qalyubia', 'khanka', 'الخانكة', 'Khanka'], ['qalyubia', 'qaha', 'قها', 'Qaha'], ['qalyubia', 'obour', 'العبور', 'Obour'],
  ['sharqia', 'zagazig', 'الزقازيق', 'Zagazig'], ['sharqia', 'tenth_of_ramadan', 'العاشر من رمضان', '10th of Ramadan'], ['sharqia', 'belbeis', 'بلبيس', 'Belbeis'], ['sharqia', 'minya_el_qamh', 'منيا القمح', 'Minya El Qamh'], ['sharqia', 'abu_hammad', 'أبو حماد', 'Abu Hammad'], ['sharqia', 'faqous', 'فاقوس', 'Faqous'],
  ['dakahlia', 'mansoura', 'المنصورة', 'Mansoura'], ['dakahlia', 'talkha', 'طلخا', 'Talkha'], ['dakahlia', 'mit_ghamr', 'ميت غمر', 'Mit Ghamr'], ['dakahlia', 'belqas', 'بلقاس', 'Belqas'], ['dakahlia', 'aga', 'أجا', 'Aga'], ['dakahlia', 'gamasa', 'جمصة', 'Gamasa'],
  ['beheira', 'damanhour', 'دمنهور', 'Damanhour'], ['beheira', 'kafr_el_dawar', 'كفر الدوار', 'Kafr El Dawar'], ['beheira', 'rashid', 'رشيد', 'Rashid'], ['beheira', 'edko', 'إدكو', 'Edko'], ['beheira', 'wadi_el_natrun', 'وادي النطرون', 'Wadi El Natrun'],
  ['kafr_el_sheikh', 'kafr_el_sheikh', 'كفر الشيخ', 'Kafr El Sheikh'], ['kafr_el_sheikh', 'desouk', 'دسوق', 'Desouk'], ['kafr_el_sheikh', 'baltim', 'بلطيم', 'Baltim'], ['kafr_el_sheikh', 'bella', 'بيلا', 'Bella'],
  ['gharbia', 'tanta', 'طنطا', 'Tanta'], ['gharbia', 'mahalla', 'المحلة الكبرى', 'El Mahalla El Kubra'], ['gharbia', 'kafr_el_zayat', 'كفر الزيات', 'Kafr El Zayat'], ['gharbia', 'zefta', 'زفتى', 'Zefta'],
  ['monufia', 'shebin_el_kom', 'شبين الكوم', 'Shebin El Kom'], ['monufia', 'menouf', 'منوف', 'Menouf'], ['monufia', 'sadat', 'السادات', 'Sadat'], ['monufia', 'ashmoun', 'أشمون', 'Ashmoun'],
  ['damietta', 'damietta', 'دمياط', 'Damietta'], ['damietta', 'new_damietta', 'دمياط الجديدة', 'New Damietta'], ['damietta', 'ras_el_bar', 'رأس البر', 'Ras El Bar'], ['damietta', 'faraskour', 'فارسكور', 'Faraskour'],
  ['port_said', 'port_said', 'بورسعيد', 'Port Said'], ['port_said', 'port_fouad', 'بورفؤاد', 'Port Fouad'],
  ['ismailia', 'ismailia', 'الإسماعيلية', 'Ismailia'], ['ismailia', 'fayed', 'فايد', 'Fayed'], ['ismailia', 'qantara_east', 'القنطرة شرق', 'Qantara East'], ['ismailia', 'qantara_west', 'القنطرة غرب', 'Qantara West'],
  ['suez', 'suez', 'السويس', 'Suez'],
  ['north_sinai', 'arish', 'العريش', 'Arish'], ['north_sinai', 'bir_el_abd', 'بئر العبد', 'Bir El Abd'], ['north_sinai', 'sheikh_zuweid', 'الشيخ زويد', 'Sheikh Zuweid'], ['north_sinai', 'rafah', 'رفح', 'Rafah'],
  ['south_sinai', 'tor', 'الطور', 'El Tor'], ['south_sinai', 'sharm_el_sheikh', 'شرم الشيخ', 'Sharm El Sheikh'], ['south_sinai', 'dahab', 'دهب', 'Dahab'], ['south_sinai', 'nuwieba', 'نويبع', 'Nuweiba'], ['south_sinai', 'ras_sudr', 'رأس سدر', 'Ras Sudr'],
  ['fayoum', 'fayoum', 'الفيوم', 'Fayoum'], ['fayoum', 'sinnuris', 'سنورس', 'Sinnuris'], ['fayoum', 'itsa', 'إطسا', 'Itsa'], ['fayoum', 'tamiya', 'طامية', 'Tamiya'],
  ['beni_suef', 'beni_suef', 'بني سويف', 'Beni Suef'], ['beni_suef', 'new_beni_suef', 'بني سويف الجديدة', 'New Beni Suef'], ['beni_suef', 'wasta', 'الواسطى', 'Wasta'], ['beni_suef', 'beba', 'ببا', 'Beba'],
  ['minya', 'minya', 'المنيا', 'Minya'], ['minya', 'new_minya', 'المنيا الجديدة', 'New Minya'], ['minya', 'mallawi', 'ملوي', 'Mallawi'], ['minya', 'samalut', 'سمالوط', 'Samalut'],
  ['assiut', 'assiut', 'أسيوط', 'Assiut'], ['assiut', 'new_assiut', 'أسيوط الجديدة', 'New Assiut'], ['assiut', 'dairut', 'ديروط', 'Dairut'], ['assiut', 'manfalut', 'منفلوط', 'Manfalut'],
  ['sohag', 'sohag', 'سوهاج', 'Sohag'], ['sohag', 'new_sohag', 'سوهاج الجديدة', 'New Sohag'], ['sohag', 'akhmim', 'أخميم', 'Akhmim'], ['sohag', 'girga', 'جرجا', 'Girga'],
  ['qena', 'qena', 'قنا', 'Qena'], ['qena', 'new_qena', 'قنا الجديدة', 'New Qena'], ['qena', 'nag_hammadi', 'نجع حمادي', 'Nag Hammadi'], ['qena', 'qous', 'قوص', 'Qous'],
  ['luxor', 'luxor', 'الأقصر', 'Luxor'], ['luxor', 'new_tiba', 'طيبة الجديدة', 'New Tiba'], ['luxor', 'esna', 'إسنا', 'Esna'], ['luxor', 'armant', 'أرمنت', 'Armant'],
  ['aswan', 'aswan', 'أسوان', 'Aswan'], ['aswan', 'new_aswan', 'أسوان الجديدة', 'New Aswan'], ['aswan', 'kom_ombo', 'كوم أمبو', 'Kom Ombo'], ['aswan', 'edfu', 'إدفو', 'Edfu'],
  ['red_sea', 'hurghada', 'الغردقة', 'Hurghada'], ['red_sea', 'ras_gharib', 'رأس غارب', 'Ras Gharib'], ['red_sea', 'safaga', 'سفاجا', 'Safaga'], ['red_sea', 'quseir', 'القصير', 'Quseir'], ['red_sea', 'marsa_alam', 'مرسى علم', 'Marsa Alam'],
  ['new_valley', 'kharga', 'الخارجة', 'Kharga'], ['new_valley', 'dakhla', 'الداخلة', 'Dakhla'], ['new_valley', 'farafra', 'الفرافرة', 'Farafra'], ['new_valley', 'paris', 'باريس', 'Paris'],
  ['matrouh', 'marsa_matrouh', 'مرسى مطروح', 'Marsa Matrouh'], ['matrouh', 'alamein', 'العلمين', 'Alamein'], ['matrouh', 'new_alamein', 'العلمين الجديدة', 'New Alamein'], ['matrouh', 'siwa', 'سيوة', 'Siwa'], ['matrouh', 'dabaa', 'الضبعة', 'Dabaa'],
] as const;
