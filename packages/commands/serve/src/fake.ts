import {
  getNamedType,
  getNullableType,
  GraphQLEnumType,
  GraphQLField,
  GraphQLFieldResolver,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLNullableType,
  GraphQLObjectType,
  GraphQLResolveInfo,
  GraphQLSchema,
  GraphQLType,
  GraphQLUnionType,
} from 'graphql';

const defaultMockMap: Map<string, GraphQLFieldResolver<any, any>> = new Map();

defaultMockMap.set('Int', () => Math.round(Math.random() * 200) - 100);
defaultMockMap.set('Float', () => Math.random() * 200 - 100);
defaultMockMap.set('String', () => 'Hello World');
defaultMockMap.set('Boolean', () => Math.random() > 0.5);
defaultMockMap.set('ID', () => Buffer.from(Math.random().toString(16)).toString('base64'));

export function fake(schema: GraphQLSchema): void {
  if (!schema) {
    throw new Error('Must provide schema to mock');
  }
  if (!(schema instanceof GraphQLSchema)) {
    throw new Error('Value at "schema" must be of type GraphQLSchema');
  }

  // use Map internally, because that API is nicer.
  const mockFunctionMap: Map<string, GraphQLFieldResolver<any, any>> = new Map();

  const mockType = function (
    type: GraphQLType,
    fieldName?: string,
  ): GraphQLFieldResolver<any, any> {
    // order of precedence for mocking:
    // 1. if the object passed in already has fieldName, just use that
    // --> if it's a function, that becomes your resolver
    // --> if it's a value, the mock resolver will return that
    // 2. if the nullableType is a list, recurse
    // 2. if there's a mock defined for this typeName, that will be used
    // 3. if there's no mock defined, use the default mocks for this type
    return (
      root: any,
      args: { [key: string]: any },
      context: any,
      info: GraphQLResolveInfo,
    ): any => {
      // nullability doesn't matter for the purpose of mocking.
      const fieldType = getNullableType(type) as GraphQLNullableType;
      const namedFieldType = getNamedType(fieldType);

      if (root && typeof root[fieldName!] !== 'undefined') {
        let result: any;

        // if we're here, the field is already defined
        if (typeof root[fieldName!] === 'function') {
          result = root[fieldName!](root, args, context, info);
          if (result instanceof MockList) {
            result = result.mock(
              root,
              args,
              context,
              info,
              fieldType as GraphQLList<any>,
              mockType,
            );
          }
        } else {
          result = root[fieldName!];
        }

        // Now we merge the result with the default mock for this type.
        // This allows overriding defaults while writing very little code.
        if (mockFunctionMap.has(namedFieldType.name)) {
          result = mergeMocks(
            mockFunctionMap.get(namedFieldType.name)!.bind(null, root, args, context, info),
            result,
          );
        }
        return result;
      }

      if (fieldType instanceof GraphQLList || fieldType instanceof GraphQLNonNull) {
        return [
          mockType(fieldType.ofType)(root, args, context, info),
          mockType(fieldType.ofType)(root, args, context, info),
        ];
      }
      if (
        mockFunctionMap.has(fieldType.name) &&
        !(fieldType instanceof GraphQLUnionType || fieldType instanceof GraphQLInterfaceType)
      ) {
        // the object passed doesn't have this field, so we apply the default mock
        return mockFunctionMap.get(fieldType.name)!(root, args, context, info);
      }
      if (fieldType instanceof GraphQLObjectType) {
        // objects don't return actual data, we only need to mock scalars!
        return {};
      }
      // if a mock function is provided for unionType or interfaceType, execute it to resolve the concrete type
      // otherwise randomly pick a type from all implementation types
      if (fieldType instanceof GraphQLUnionType || fieldType instanceof GraphQLInterfaceType) {
        let implementationType;
        if (mockFunctionMap.has(fieldType.name)) {
          const interfaceMockObj: any = mockFunctionMap.get(fieldType.name)!(
            root,
            args,
            context,
            info,
          );
          if (!interfaceMockObj?.__typename) {
            return Error(`Please return a __typename in "${fieldType.name}"`);
          }
          implementationType = schema.getType(interfaceMockObj.__typename);
        } else {
          const possibleTypes = schema.getPossibleTypes(fieldType);
          implementationType = getRandomElement(possibleTypes);
        }
        return Object.assign(
          { __typename: implementationType },
          mockType(implementationType)(root, args, context, info),
        );
      }

      if (fieldType instanceof GraphQLEnumType) {
        return getRandomElement(fieldType.getValues()).value;
      }

      if (defaultMockMap.has(fieldType.name)) {
        return defaultMockMap.get(fieldType.name)!(root, args, context, info);
      }

      // if we get to here, we don't have a value, and we don't have a mock for this type,
      // we could return undefined, but that would be hard to debug, so we throw instead.
      // however, we returning it instead of throwing it, so preserveResolvers can handle the failures.
      return Error(`No mock defined for type "${fieldType.name}"`);
    };
  };

  forEachField(schema, (field: GraphQLField<any, any>, typeName: string, fieldName: string) => {
    assignResolveType(field.type);
    let mockResolver: GraphQLFieldResolver<any, any> = mockType(field.type, fieldName);

    // we have to handle the root mutation and root query types differently,
    // because no resolver is called at the root.
    /* istanbul ignore next: Must provide schema DefinitionNode with query type or a type named Query. */
    const isOnQueryType: boolean =
      typeof schema.getQueryType() === 'object' && schema.getQueryType()!.name === typeName;
    const isOnMutationType: boolean =
      typeof schema.getMutationType() === 'object' && schema.getMutationType()!.name === typeName;

    if ((isOnQueryType || isOnMutationType) && mockFunctionMap.has(typeName)) {
      const rootMock = mockFunctionMap.get(typeName);
      // XXX: BUG in here, need to provide proper signature for rootMock.
      if (typeof (rootMock!(undefined, {}, {}, {} as any) as any)[fieldName] === 'function') {
        mockResolver = (
          root: any,
          args: { [key: string]: any },
          context: any,
          info: GraphQLResolveInfo,
        ) => {
          const updatedRoot = root || {}; // TODO: should we clone instead?
          updatedRoot[fieldName] = (rootMock!(root, args, context, info) as any)[fieldName];
          // XXX this is a bit of a hack to still use mockType, which
          // lets you mock lists etc. as well
          // otherwise we could just set field.resolve to rootMock()[fieldName]
          // it's like pretending there was a resolve function that ran before
          // the root resolve function.
          return mockType(field.type, fieldName)(updatedRoot, args, context, info);
        };
      }
    }
    mockResolver = mockType(field.type, fieldName);
    field.resolve = mockResolver;
  });
}

function isObject(thing: any) {
  return thing === Object(thing) && !Array.isArray(thing);
}

// returns a random element from that ary
function getRandomElement(ary: ReadonlyArray<any>) {
  const sample = Math.floor(Math.random() * ary.length);
  return ary[sample];
}

function mergeObjects(a: object, b: object) {
  return Object.assign(a, b);
}

// takes either an object or a (possibly nested) array
// and completes the customMock object with any fields
// defined on genericMock
// only merges objects or arrays. Scalars are returned as is
function mergeMocks(genericMockFunction: () => any, customMock: any): any {
  if (Array.isArray(customMock)) {
    return customMock.map((el: any) => mergeMocks(genericMockFunction, el));
  }
  if (isObject(customMock)) {
    return mergeObjects(genericMockFunction(), customMock);
  }
  return customMock;
}

function assignResolveType(type: GraphQLType) {
  const fieldType = getNullableType(type) as GraphQLNullableType;
  const namedFieldType = getNamedType(fieldType);

  if (
    namedFieldType instanceof GraphQLUnionType ||
    namedFieldType instanceof GraphQLInterfaceType
  ) {
    // the default `resolveType` always returns null. We add a fallback
    // resolution that works with how unions and interface are mocked
    namedFieldType.resolveType = (data: any) => data.__typename;
  }
}

function forEachField(schema: GraphQLSchema, fn: any): void {
  const typeMap = schema.getTypeMap();
  for (const typeName of Object.keys(typeMap)) {
    const type = typeMap[typeName];

    // TODO: maybe have an option to include these?
    if (!getNamedType(type).name.startsWith('__') && type instanceof GraphQLObjectType) {
      const fields = type.getFields();
      for (const fieldName of Object.keys(fields)) {
        const field = fields[fieldName];
        fn(field, typeName, fieldName);
      }
    }
  }
}

class MockList {
  private len: number | number[];
  private wrappedFunction?: GraphQLFieldResolver<any, any>;

  // wrappedFunction can return another MockList or a value
  constructor(len: number | number[], wrappedFunction?: GraphQLFieldResolver<any, any>) {
    this.len = len;
    if (typeof wrappedFunction !== 'undefined') {
      if (typeof wrappedFunction !== 'function') {
        throw new Error('Second argument to MockList must be a function or undefined');
      }
      this.wrappedFunction = wrappedFunction;
    }
  }

  public mock(
    root: any,
    args: { [key: string]: any },
    context: any,
    info: GraphQLResolveInfo,
    fieldType: GraphQLList<any>,
    mockTypeFunc: any,
  ) {
    let arr: any[];
    if (Array.isArray(this.len)) {
      arr = new Array(this.randint(this.len[0], this.len[1]));
    } else {
      arr = new Array(this.len);
    }

    for (let i = 0; i < arr.length; i++) {
      if (typeof this.wrappedFunction === 'function') {
        const res = this.wrappedFunction(root, args, context, info);
        if (res instanceof MockList) {
          const nullableType = getNullableType(fieldType.ofType) as GraphQLList<any>;
          arr[i] = res.mock(root, args, context, info, nullableType, mockTypeFunc);
        } else {
          arr[i] = res;
        }
      } else {
        arr[i] = mockTypeFunc(fieldType.ofType)(root, args, context, info);
      }
    }
    return arr;
  }

  private randint(low: number, high: number): number {
    return Math.floor(Math.random() * (high - low + 1) + low);
  }
}
