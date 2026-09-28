import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { renderCppClass } from '../src/class-template.ts';

const author = process.env.USERNAME || process.env.USER || userInfo().username;
const createdOn = new Date();
const formattedCreationDate = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
}).format(createdOn);
const generated = renderCppClass('NewClass', 'src/NewClass.h', author, createdOn);

assert.equal(generated.sourceContent, [
  ' /*',
  ' * NewClass.cpp',
  ' *',
  ` *  Created on: ${formattedCreationDate}`,
  ` *      Author: ${author}`,
  ' */',
  '',
  '#include "NewClass.h"',
  '',
  'NewClass::NewClass() {',
  '\t// TODO Auto-generated constructor stub',
  '',
  '}',
  '',
  'NewClass::~NewClass() {',
  '\t// TODO Auto-generated destructor stub',
  '}',
  '',
].join('\n'));

assert.equal(generated.headerContent, [
  ' /*',
  ' * NewClass.h',
  ' *',
  ` *  Created on: ${formattedCreationDate}`,
  ` *      Author: ${author}`,
  ' */',
  '',
  '#ifndef SRC_NEWCLASS_H_',
  '#define SRC_NEWCLASS_H_',
  '',
  'class NewClass {',
  'public:',
  '\tNewClass();',
  '\tvirtual ~NewClass();',
  '};',
  '',
  '#endif /* SRC_NEWCLASS_H_ */',
  '',
].join('\n'));

console.log('C++ class template tests passed.');
