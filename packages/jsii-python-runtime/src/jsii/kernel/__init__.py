from typing import Any, List, Optional, Type

import attr

from jsii._utils import Singleton
from jsii.kernel.providers import BaseKernel, ProcessKernel
from jsii.kernel.types import (
    LoadRequest,
    CreateRequest,
    DeleteRequest,
    GetRequest,
    InvokeRequest,
    SetRequest,
    StaticGetRequest,
    StaticInvokeRequest,
    StaticSetRequest,
    StatsRequest,
    ObjRef,
)


@attr.s(auto_attribs=True, frozen=True, slots=True)
class Statistics:

    object_count: int


class Kernel(metaclass=Singleton):

    # This class translates between the Pythonic interface for the kernel, and the
    # Kernel Provider interface that maps more directly to the JSII Kernel interface.
    # It currently only supports the idea of a process kernel provider, however it
    # should be possible to move to other providers in the future.

    # TODO: We don't currently have any error handling, but we need to. This should
    #       probably live at the provider layer though, maybe with something catching
    #       them at this layer to translate it to something more Pythonic, depending
    #       on what the provider layer looks like.

    def __init__(self, provider_class: Type[BaseKernel] = ProcessKernel) -> None:
        self.provider = provider_class()

    # TODO: Do we want to return anything from this method? Is the return value useful
    #       to anyone?
    def load(self, name: str, version: str, tarball: str) -> None:
        self.provider.load(LoadRequest(name=name, version=version, tarball=tarball))

    # TODO: Can we do protocols in typing?
    def create(self, klass: Any) -> ObjRef:
        return self.provider.create(CreateRequest(fqn=klass.__jsii_type__))

    def delete(self, ref: ObjRef) -> None:
        self.provider.delete(DeleteRequest(objref=ref))

    def get(self, ref: ObjRef, property: str) -> Any:
        return self.provider.get(GetRequest(objref=ref, property_=property)).value

    def set(self, ref: ObjRef, property: str, value: Any) -> None:
        self.provider.set(
            SetRequest(objref=ref, property_=property, value=value)
        )

    def sget(self, klass: Any, property: str) -> Any:
        return self.provider.sget(
            StaticGetRequest(fqn=klass.__jsii_type__, property_=property)
        ).value

    def sset(self, klass: Any, property: str, value: Any) -> None:
        return self.provider.sset(
            StaticSetRequest(fqn=klass.__jsii_type__, property_=property, value=value)
        )

    def invoke(self, ref: ObjRef, method: str, args: Optional[List[Any]] = None) -> Any:
        if args is None:
            args = []

        return self.provider.invoke(
            InvokeRequest(objref=ref, method=method, args=args)
        ).result

    def sinvoke(self, klass: Any, method: str, args: Optional[List[Any]] = None) -> Any:
        if args is None:
            args = []

        return self.provider.sinvoke(
            StaticInvokeRequest(fqn=klass.__jsii_type__, method=method, args=args)
        ).result

    def stats(self):
        resp = self.provider.stats(StatsRequest())

        return Statistics(object_count=resp.objectCount)