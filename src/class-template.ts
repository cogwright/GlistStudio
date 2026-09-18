export interface CppClassFiles {
  headerContent: string;
  sourceContent: string;
}

export const renderCppClass = (
  className: string,
  relativeHeaderPath: string,
  author: string,
  createdOn: Date,
): CppClassFiles => {
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(createdOn);
  const safeAuthor = author.replace(/[\r\n]/g, ' ').trim();
  const guard = `${relativeHeaderPath.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_`;
  const comment = (fileName: string): string =>
    `/*\n * ${fileName}\n *\n *  Created on: ${date}\n *      Author: ${safeAuthor}\n */\n\n`;

  return {
    headerContent: `${comment(`${className}.h`)}#ifndef ${guard}\n#define ${guard}\n\nclass ${className} {\npublic:\n\t${className}();\n\tvirtual ~${className}();\n};\n\n#endif /* ${guard} */\n`,
    sourceContent: `${comment(`${className}.cpp`)}#include "${className}.h"\n\n${className}::${className}() {\n\t// TODO Auto-generated constructor stub\n\n}\n\n${className}::~${className}() {\n\t// TODO Auto-generated destructor stub\n}\n`,
  };
};
